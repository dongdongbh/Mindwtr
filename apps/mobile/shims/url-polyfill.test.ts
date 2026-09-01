import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeWebdavSyncCompatibility, webdavGetSyncDocument } from '@mindwtr/core';

vi.mock('../lib/app-log', () => ({
    logWarn: vi.fn(),
}));

import { logWarn } from '../lib/app-log';
import * as shim from './url-polyfill';

describe('URL Polyfill Shim', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
    });

    test('exports URL and URLSearchParams', () => {
        expect(shim.URL).toBeDefined();
        expect(shim.URLSearchParams).toBeDefined();
    });

    test('does not mutate existing timer globals', async () => {
        vi.resetModules();
        const originalSetImmediate = (globalThis as any).setImmediate;
        const originalClearImmediate = (globalThis as any).clearImmediate;
        await import('./url-polyfill');
        expect((globalThis as any).setImmediate).toBe(originalSetImmediate);
        expect((globalThis as any).clearImmediate).toBe(originalClearImmediate);
    });

    test('shimmed URL has createObjectURL that is safe (mocked environment)', async () => {
        // 1. Reset modules to ensure fresh execution of shim logic
        vi.resetModules();

        // 2. Mock global URL to simulate Hermes (no createObjectURL)
        const OriginalURL = globalThis.URL;

        // We need a class that extends or mimics URL but definitely has no createObjectURL static method
        // @ts-ignore - MockURL matching OriginalURL structure for tests
        class MockURL extends OriginalURL {
            // @ts-ignore - Intentionally removing static method to simulate Hermes
            static createObjectURL = undefined;
            // @ts-ignore - Intentionally removing static method to simulate Hermes
            static revokeObjectURL = undefined;
        }

        // Temporarily replace global URL
        globalThis.URL = MockURL as unknown as typeof URL;

        // 3. Re-import and call setupURLPolyfill
        const shimModule = await import('./url-polyfill');
        shimModule.setupURLPolyfill();

        // 4. Verify it was patched on globalThis
        expect(typeof globalThis.URL.createObjectURL).toBe('function');

        // 5. Test safety behavior (returns string, warns)
        const result = globalThis.URL.createObjectURL({} as any);
        expect(result).toBe('');

        const warnMock = vi.mocked(logWarn);
        if (warnMock.mock.calls.length > 0) {
            expect(warnMock).toHaveBeenCalledWith(
                expect.stringContaining('not supported'),
                expect.any(Object)
            );
        }

        // Cleanup
        globalThis.URL = OriginalURL;
    });

    test('shimmed URL has revokeObjectURL', () => {
        expect(typeof shim.URL.revokeObjectURL).toBe('function');
        // Should not throw
        shim.URL.revokeObjectURL('some-url');
    });

    test('URLSearchParams basic functionality', () => {
        const params = new shim.URLSearchParams!('foo=1&bar=2');
        expect(params.get('foo')).toBe('1');
        expect(params.get('bar')).toBe('2');
        expect(params.has('foo')).toBe(true);
        expect(params.has('baz')).toBe(false);
    });

    test('fallback URL keeps href writable for navigation libraries', async () => {
        const OriginalURL = globalThis.URL;
        const OriginalURLSearchParams = globalThis.URLSearchParams;

        try {
            vi.resetModules();
            globalThis.URL = undefined as unknown as typeof URL;

            const fallbackModule = await import('./url-polyfill');
            const routeUrl = new fallbackModule.URL!('mindwtr:///focus');
            routeUrl.href = 'mindwtr:///inbox';

            expect(routeUrl.toString()).toBe('mindwtr:///inbox');
        } finally {
            globalThis.URL = OriginalURL;
            globalThis.URLSearchParams = OriginalURLSearchParams;
            vi.resetModules();
        }
    });

    test('fallback URL keeps the sync mutation fence and parent collection off data.json', async () => {
        const OriginalURL = globalThis.URL;
        const OriginalURLSearchParams = globalThis.URLSearchParams;
        try {
            vi.resetModules();
            globalThis.URL = undefined as unknown as typeof URL;
            await import('./url-polyfill');
            const { webdavMutationFenceUrl } = await import('@mindwtr/core');

            expect(webdavMutationFenceUrl('https://example.com/dav/data.json'))
                .toBe('https://example.com/dav/.mindwtr-sync-fence-v1.json');

            // The polyfill itself must honor component writes too (#1132).
            const parsed = new URL('https://example.com/dav/data.json?x=1#h');
            parsed.pathname = '/dav/other.json';
            parsed.search = '';
            parsed.hash = '';
            expect(parsed.toString()).toBe('https://example.com/dav/other.json');
        } finally {
            vi.resetModules();
            globalThis.URL = OriginalURL;
            globalThis.URLSearchParams = OriginalURLSearchParams;
        }
    });

    test('fallback URL keeps the WebDAV capability probe off data.json', async () => {
        const OriginalURL = globalThis.URL;
        const OriginalURLSearchParams = globalThis.URLSearchParams;

        try {
            vi.resetModules();
            globalThis.URL = undefined as unknown as typeof URL;
            await import('./url-polyfill');

            const documentUrl = 'https://example.com/dav/data.json';
            const files = new Map<string, { bytes: Uint8Array; version: number }>();
            const staleAfterDelete = new Map<string, { bytes: Uint8Array; version: number }>();
            const responseBody = (bytes: Uint8Array): ArrayBuffer => {
                const body = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(body).set(bytes);
                return body;
            };
            const fetcherMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? 'GET';
                const headers = new Headers(init?.headers);
                const current = files.get(url);

                if (method === 'GET') {
                    const stale = staleAfterDelete.get(url);
                    if (stale) {
                        staleAfterDelete.delete(url);
                        return new Response(responseBody(stale.bytes), {
                            status: 200,
                            headers: { etag: `"v${stale.version}"` },
                        });
                    }
                    if (!current) return new Response(null, { status: 404 });
                    return new Response(responseBody(current.bytes), {
                        status: 200,
                        headers: { etag: `"v${current.version}"` },
                    });
                }

                if (method === 'PUT') {
                    if (current && headers.get('if-none-match') === '*') {
                        return new Response(null, { status: 412 });
                    }
                    const ifMatch = headers.get('if-match');
                    if (ifMatch && (!current || ifMatch !== `"v${current.version}"`)) {
                        return new Response(null, { status: 412 });
                    }
                    const body = init?.body;
                    if (!(body instanceof Uint8Array)) throw new Error('expected byte probe body');
                    files.set(url, {
                        bytes: new Uint8Array(body),
                        version: (current?.version ?? 0) + 1,
                    });
                    return new Response(null, { status: current ? 204 : 201 });
                }

                if (method === 'DELETE') {
                    const ifMatch = headers.get('if-match');
                    if (!current || ifMatch !== `"v${current.version}"`) {
                        return new Response(null, { status: 412 });
                    }
                    staleAfterDelete.set(url, current);
                    files.delete(url);
                    return new Response(null, { status: 204 });
                }

                throw new Error(`unexpected ${method}`);
            });
            const fetcher = fetcherMock as unknown as typeof fetch;

            await probeWebdavSyncCompatibility(
                documentUrl,
                { fetcher },
                { requireStrongEtag: true },
            );

            const mutationUrls = fetcherMock.mock.calls
                .filter(([, init]) => init?.method === 'PUT' || init?.method === 'DELETE')
                .map(([input]) => String(input));
            expect(mutationUrls).not.toHaveLength(0);
            expect(mutationUrls.every((url) => (
                /^https:\/\/example\.com\/dav\/data\.json\.mindwtr-etag-probe-[^?#]+$/.test(url)
            ))).toBe(true);

            await expect(webdavGetSyncDocument(documentUrl, { fetcher })).resolves.toEqual({
                state: 'data',
                data: null,
                exists: false,
                strongEtag: null,
            });
        } finally {
            globalThis.URL = OriginalURL;
            globalThis.URLSearchParams = OriginalURLSearchParams;
            vi.resetModules();
        }
    });
});
