import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '@mindwtr/core';
import {
    isSupportedProxyUrl,
    normalizeProxyUrl,
    syncNativeProxyUrl,
    withCancelSafeBody,
    withTauriHttpProxy,
} from './tauri-http';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invokeMock(...args),
}));

const isTauriRuntimeMock = vi.fn(() => true);
vi.mock('./runtime', () => ({
    isTauriRuntime: () => isTauriRuntimeMock(),
}));

describe('tauri http proxy helpers', () => {
    it('normalizes proxy URLs from settings input', () => {
        expect(normalizeProxyUrl('  http://proxy.local:8080  ')).toBe('http://proxy.local:8080');
        expect(normalizeProxyUrl(undefined)).toBe('');
        expect(normalizeProxyUrl(42)).toBe('');
    });

    it('accepts blank, http, and https proxy URLs only', () => {
        expect(isSupportedProxyUrl('')).toBe(true);
        expect(isSupportedProxyUrl(' http://proxy.local:8080 ')).toBe(true);
        expect(isSupportedProxyUrl('https://proxy.local:8443')).toBe(true);
        expect(isSupportedProxyUrl('socks5://proxy.local:1080')).toBe(false);
        expect(isSupportedProxyUrl('proxy.local:8080')).toBe(false);
    });

    it('leaves fetch unchanged when no proxy is configured', () => {
        const baseFetch = vi.fn() as unknown as typeof fetch;

        expect(withTauriHttpProxy(baseFetch, '   ')).toBe(baseFetch);
    });

    it('adds the proxy to Tauri fetch options while preserving existing init fields', async () => {
        const response = new Response('ok');
        const baseFetch = vi.fn(async () => response) as unknown as typeof fetch;
        const proxiedFetch = withTauriHttpProxy(baseFetch, ' http://proxy.local:8080 ');

        await proxiedFetch('https://example.com/data.ics', {
            method: 'GET',
            headers: { Accept: 'text/calendar' },
        });

        expect(baseFetch).toHaveBeenCalledWith('https://example.com/data.ics', {
            method: 'GET',
            headers: { Accept: 'text/calendar' },
            proxy: { all: 'http://proxy.local:8080' },
        });
    });

    describe('syncNativeProxyUrl', () => {
        beforeEach(() => {
            invokeMock.mockReset();
            isTauriRuntimeMock.mockReturnValue(true);
        });

        it('mirrors the saved proxy into the native config', async () => {
            await syncNativeProxyUrl(' http://proxy.local:8080 ');

            expect(invokeMock).toHaveBeenCalledWith('set_network_proxy', {
                proxyUrl: 'http://proxy.local:8080',
            });
        });

        it('propagates an explicit clear as an empty value', async () => {
            await syncNativeProxyUrl('');

            expect(invokeMock).toHaveBeenCalledWith('set_network_proxy', { proxyUrl: '' });
        });

        it('leaves the native config untouched when the setting was never configured', async () => {
            await syncNativeProxyUrl(undefined);

            expect(invokeMock).not.toHaveBeenCalled();
        });

        it('does nothing outside the Tauri runtime', async () => {
            isTauriRuntimeMock.mockReturnValue(false);

            await syncNativeProxyUrl('http://proxy.local:8080');

            expect(invokeMock).not.toHaveBeenCalled();
        });
    });
});

/**
 * Mirrors how `@tauri-apps/plugin-http` builds a response: a `ReadableStream` fed by an
 * IPC channel that calls `controller.close()` when the terminator message arrives, with
 * `url`/`headers` bolted on afterwards. `deliverTerminator` plays that late message.
 */
const createPluginResponse = (chunks: string[] = [], status = 200) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulled = false;
    const sourceCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
        start: (c) => {
            controller = c;
            for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        },
        pull: () => {
            pulled = true;
        },
        cancel: sourceCancel,
    });
    const res = new Response(body, { status: 200, statusText: 'OK' });
    // The constructor refuses a body for a null-body status, so shadow the getter the same
    // way the plugin shadows `url` and `headers`.
    if (status !== 200) Object.defineProperty(res, 'status', { value: status });
    Object.defineProperty(res, 'url', { value: 'https://dav.example.com/attachments/a.bin' });
    Object.defineProperty(res, 'headers', { value: new Headers({ etag: '"abc"' }) });
    return {
        res,
        sourceCancel,
        deliverTerminator: () => controller.close(),
        wasRead: () => pulled,
    };
};

describe('withCancelSafeBody', () => {
    it('keeps the plugin stream closable after the response body is cancelled', async () => {
        const { res, deliverTerminator } = createPluginResponse();
        const safeFetch = withCancelSafeBody((async () => res) as unknown as typeof fetch);

        const wrapped = await safeFetch('https://dav.example.com/attachments/a.bin', { method: 'HEAD' });
        await wrapped.body?.cancel();

        expect(() => deliverTerminator()).not.toThrow();
    });

    it('survives the cancel core performs for a status-only HEAD consumer', async () => {
        const { res, deliverTerminator } = createPluginResponse();
        const safeFetch = withCancelSafeBody((async () => res) as unknown as typeof fetch);

        const response = await fetchWithTimeout(
            'https://dav.example.com/attachments/a.bin',
            { method: 'HEAD' },
            5_000,
            safeFetch,
            'timed out',
        );
        await Promise.resolve();

        expect(response.status).toBe(200);
        expect(() => deliverTerminator()).not.toThrow();
    });

    it('passes body, status, url, and headers through untouched', async () => {
        const { res, deliverTerminator } = createPluginResponse(['hello ', 'world']);
        const safeFetch = withCancelSafeBody((async () => res) as unknown as typeof fetch);

        const wrapped = await safeFetch('https://dav.example.com/attachments/a.bin');
        deliverTerminator();

        expect(await wrapped.text()).toBe('hello world');
        expect(wrapped.status).toBe(200);
        expect(wrapped.url).toBe('https://dav.example.com/attachments/a.bin');
        expect(wrapped.headers.get('etag')).toBe('"abc"');
    });

    it('drains rather than attaches the body of a null-body status such as a 204 DELETE', async () => {
        const { res, deliverTerminator, sourceCancel, wasRead } = createPluginResponse(['x'], 204);
        const safeFetch = withCancelSafeBody((async () => res) as unknown as typeof fetch);

        const wrapped = await safeFetch('https://dav.example.com/attachments/a.bin', { method: 'DELETE' });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(wrapped.status).toBe(204);
        expect(wrapped.body).toBeNull();
        expect(wasRead()).toBe(true);
        expect(sourceCancel).not.toHaveBeenCalled();
        expect(() => deliverTerminator()).not.toThrow();
    });

    it('leaves a body-less response alone', async () => {
        const res = new Response(null, { status: 204 });
        const safeFetch = withCancelSafeBody((async () => res) as unknown as typeof fetch);

        expect(await safeFetch('https://dav.example.com/attachments/a.bin')).toBe(res);
    });
});
