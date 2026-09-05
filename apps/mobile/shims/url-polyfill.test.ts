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

    test('fallback URL resolves an absolute path against the bases expo-router uses', async () => {
        // expo-router parses every navigation path with `new URL(path, 'file:')`
        // and resolves hrefs against `exp://host`. A shim revision that derived
        // the base href with a trailing "/" turned '/focus' into '//focus', so no
        // route ever matched and the root navigator reset in a loop (Expo Go
        // flashed black with "Refreshing..."; bisected to the #1132 commit).
        vi.resetModules();
        const OriginalURL = globalThis.URL;
        // @ts-expect-error simulate a runtime without a native URL
        globalThis.URL = undefined;
        try {
            const shimModule = await import('./url-polyfill');
            const FallbackURL = shimModule.URL as unknown as typeof URL;
            expect(new FallbackURL('/focus', 'file:').pathname).toBe('/focus');
            const resolved = new FallbackURL('/focus', 'exp://127.0.0.1:8081');
            expect(resolved.pathname).toBe('/focus');
            expect(resolved.href).toBe('exp://127.0.0.1:8081/focus');
            expect(new FallbackURL('exp://127.0.0.1:8081/--/focus?x=1').pathname).toBe('/--/focus');
        } finally {
            globalThis.URL = OriginalURL;
            vi.resetModules();
        }
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

    test('fallback URL exposes origin and host fields for the Expo location polyfill', async () => {
        // @expo/metro-runtime builds window.location from this class and Expo's
        // split-bundle loader joins location.origin with the chunk path, so an
        // undefined origin breaks every dynamic import() in a dev client.
        const OriginalURL = globalThis.URL;
        try {
            vi.resetModules();
            globalThis.URL = undefined as unknown as typeof URL;
            const fallbackModule = await import('./url-polyfill');
            const FallbackURL = fallbackModule.URL as unknown as typeof URL;
            const bundle = new FallbackURL('http://127.0.0.1:8081/apps/mobile/index.bundle//&platform=android&dev=true');
            expect(bundle.origin).toBe('http://127.0.0.1:8081');
            expect(bundle.host).toBe('127.0.0.1:8081');
            expect(bundle.hostname).toBe('127.0.0.1');
            expect(bundle.port).toBe('8081');
            expect(bundle.pathname).toBe('/apps/mobile/index.bundle//&platform=android&dev=true');
            const dav = new FallbackURL('https://user:pw@dav.example.com/remote.php/dav/');
            expect(dav.origin).toBe('https://dav.example.com');
            expect(dav.hostname).toBe('dav.example.com');
            expect(dav.port).toBe('');
            expect(new FallbackURL('file:///focus').origin).toBe('null');
            expect(new FallbackURL('mindwtr:///focus').host).toBe('');
        } finally {
            globalThis.URL = OriginalURL;
            vi.resetModules();
        }
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
