import { describe, expect, it, vi } from 'vitest';
import {
    fetchWithTimeout,
    fetchWithTimeoutAndConsume,
    isAllowedInsecureUrl,
    isConnectionAllowed,
    MAX_DOWNLOAD_BYTES,
    readResponseBody,
    ResponseTooLargeError,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
} from './http-utils';
import { DEFAULT_MAX_FILE_SIZE_BYTES } from './attachment-validation';

describe('isAllowedInsecureUrl', () => {
    it('allows HTTPS URLs', () => {
        expect(isAllowedInsecureUrl('https://example.com/data.json')).toBe(true);
    });

    it('rejects HTTP(S) URLs without a hostname', () => {
        expect(isAllowedInsecureUrl('https://')).toBe(false);
        expect(isAllowedInsecureUrl('http:///data.json')).toBe(false);
    });

    it('allows loopback hosts for HTTP', () => {
        expect(isAllowedInsecureUrl('http://localhost/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://127.0.0.1/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://127.255.255.254/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://[::1]/data.json')).toBe(true);
    });

    it('blocks private ranges unless explicitly enabled', () => {
        expect(isAllowedInsecureUrl('http://10.1.2.3/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://172.16.5.9/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://192.168.1.50/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://100.64.10.2/data.json')).toBe(false);
    });

    it('allows RFC1918 and CGNAT ranges when enabled', () => {
        const options = { allowPrivateIpRanges: true };
        expect(isAllowedInsecureUrl('http://10.1.2.3/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://172.16.0.1/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://172.31.255.255/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://192.168.1.50/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://100.64.0.1/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://100.127.255.255/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://[fd00::1]/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://[fe80::1]/data.json', options)).toBe(true);
    });

    it('allows clearly local hostnames when enabled', () => {
        const options = { allowLocalHostnames: true };
        expect(isAllowedInsecureUrl('http://nas/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://omvnas/webdav/alice/mindwtr', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://nas.local/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://router.home.arpa/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://example.com/data.json', options)).toBe(false);
    });

    it('keeps private range boundaries strict', () => {
        const options = { allowPrivateIpRanges: true };
        expect(isAllowedInsecureUrl('http://172.15.255.255/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://172.32.0.1/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://100.63.255.255/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://100.128.0.1/data.json', options)).toBe(false);
    });

    it('preserves Android emulator override behavior', () => {
        expect(isAllowedInsecureUrl('http://10.0.2.2/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://10.0.2.2/data.json', { allowAndroidEmulator: true })).toBe(true);
    });
});

describe('isConnectionAllowed', () => {
    it('allows local sync HTTP targets without a manual override', () => {
        expect(isConnectionAllowed('http://192.168.1.50/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
        expect(isConnectionAllowed('http://omvnas/webdav/alice/mindwtr', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
        expect(isConnectionAllowed('http://nas.local/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
    });

    it('allows public HTTP hostnames only with the manual override', () => {
        expect(isConnectionAllowed('http://example.com/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(false);
        expect(isConnectionAllowed('http://nas.mydomain.tld:8787/v1/data', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(false);
        const override = { ...SYNC_LOCAL_INSECURE_URL_OPTIONS, allowInsecureHttp: true };
        expect(isConnectionAllowed('http://example.com/data.json', override)).toBe(true);
        expect(isConnectionAllowed('http://nas.mydomain.tld:8787/v1/data', override)).toBe(true);
        expect(isConnectionAllowed('http://machine.tailnet.ts.net/v1/data', override)).toBe(true);
    });

    it('never lets the manual override admit malformed or non-HTTP URLs', () => {
        const override = { ...SYNC_LOCAL_INSECURE_URL_OPTIONS, allowInsecureHttp: true };
        expect(isConnectionAllowed('http://', override)).toBe(false);
        expect(isConnectionAllowed('ftp://example.com/data.json', override)).toBe(false);
        expect(isConnectionAllowed('', override)).toBe(false);
    });

    it('falls back to raw host parsing when URL lacks hostname support', () => {
        const originalUrl = globalThis.URL;

        class ProtocolOnlyURL {
            hostname = undefined;
            protocol: string;

            constructor(value: string) {
                const match = value.match(/^([a-z][a-z0-9.+-]*:)/i);
                if (!match) throw new TypeError('Invalid URL');
                this.protocol = match[1].toLowerCase();
            }
        }

        globalThis.URL = ProtocolOnlyURL as unknown as typeof URL;
        try {
            expect(isConnectionAllowed('http://omvnas/webdav/alice/mindwtr', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
            expect(isConnectionAllowed('http://192.168.1.50/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
            expect(isConnectionAllowed('http://example.com/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(false);
        } finally {
            globalThis.URL = originalUrl;
        }
    });
});

describe('fetchWithTimeout', () => {
    it('adds duplex=half for ReadableStream request bodies', async () => {
        let receivedInit: (RequestInit & { duplex?: 'half' }) | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
            },
        });

        await fetchWithTimeout(
            'https://example.com/upload',
            { method: 'PUT', body },
            1_000,
            async (_input, init) => {
                receivedInit = init as RequestInit & { duplex?: 'half' };
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        );

        expect(receivedInit?.duplex).toBe('half');
    });

    it('does not add duplex for non-stream bodies', async () => {
        let receivedInit: (RequestInit & { duplex?: 'half' }) | undefined;

        await fetchWithTimeout(
            'https://example.com/upload',
            { method: 'PUT', body: JSON.stringify({ ok: true }) },
            1_000,
            async (_input, init) => {
                receivedInit = init as RequestInit & { duplex?: 'half' };
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        );

        expect(receivedInit?.duplex).toBeUndefined();
    });

    it('preserves caller abort reasons instead of reporting a timeout', async () => {
        const controller = new AbortController();
        const reason = new Error('Sync cancelled');
        reason.name = 'AbortError';
        controller.abort(reason);

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Sync cancelled');
    });

    it('removes the caller abort listener after a completed request', async () => {
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, 'addEventListener');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');

        await fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async () => new Response(null, { status: 200 }),
            'Request timed out',
        );

        expect(add).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    });

    it('keeps timeout and cancellation active until the response body settles', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({
            cancel,
        }));

        await expect(fetchWithTimeoutAndConsume(
            'https://example.com/data.json',
            {},
            1,
            async () => response,
            'Request timed out',
            (res, signal) => readResponseBody(res, undefined, MAX_DOWNLOAD_BYTES, signal),
        )).rejects.toThrow('Request timed out');

        expect(cancel).toHaveBeenCalledOnce();
    });

    it('cancels an unlocked response body when the consumer rejects before reading it', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

        await expect(fetchWithTimeoutAndConsume(
            'https://example.com/data.json',
            {},
            1_000,
            async () => response,
            'Request timed out',
            async () => { throw new Error('HTTP 401'); },
        )).rejects.toThrow('HTTP 401');

        expect(cancel).toHaveBeenCalledOnce();
        expect(response.bodyUsed).toBe(true);
    });

    it('keeps the caller abort listener until body consumption finishes, then removes it', async () => {
        const controller = new AbortController();
        const reason = new DOMException('Sync cancelled during download', 'AbortError');
        const add = vi.spyOn(controller.signal, 'addEventListener');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
        const pending = fetchWithTimeoutAndConsume(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async () => response,
            'Request timed out',
            (res, signal) => readResponseBody(res, undefined, MAX_DOWNLOAD_BYTES, signal),
        );

        await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
        expect(remove).not.toHaveBeenCalled();
        controller.abort(reason);

        await expect(pending).rejects.toThrow('Sync cancelled during download');
        expect(cancel).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    });

    it('falls back to a cancellation message for non-Error abort reasons', async () => {
        const controller = new AbortController();
        controller.abort({ name: 'AbortError', message: 'Native cancellation' });

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Request cancelled');
    });

    it('preserves DOMException abort reasons', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('Native cancellation', 'AbortError'));

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Native cancellation');
    });

    it.each([
        ['blank string', ' '],
        ['number', 42],
        ['null', null],
        ['symbol', Symbol('abort')],
    ])('falls back to a cancellation message for %s abort reasons', async (_label, reason) => {
        const controller = new AbortController();
        controller.abort(reason);

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Request cancelled');
    });

    it('reports timeout when its own timer aborts the request', async () => {
        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            {},
            1,
            async (_input, init) => {
                const signal = init?.signal as AbortSignal | undefined;
                await new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => {
                        const error = new Error('Fetch aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        )).rejects.toThrow('Request timed out');
    });

    it.each(['PUT', 'POST', 'PATCH', 'DELETE'])(
        'refuses to follow a redirect on %s so the body is never replayed to another origin',
        async (method) => {
            const calls: string[] = [];
            const fetcher: typeof fetch = async (input, init) => {
                calls.push(String(input));
                // Mirrors undici/browser fetch: redirect:'error' rejects instead of
                // re-issuing the request (with its body) at the Location target.
                if (init?.redirect === 'error') throw new TypeError('unexpected redirect');
                return new Response(null, {
                    status: 307,
                    headers: { location: 'https://attacker.example/steal' },
                });
            };

            await expect(fetchWithTimeout(
                'https://dav.example.com/data.json',
                { method, body: '{"tasks":[]}' },
                1_000,
                fetcher,
                'Request timed out',
            )).rejects.toThrow('unexpected redirect');
            expect(calls).toEqual(['https://dav.example.com/data.json']);
        },
    );

    it.each(['GET', 'HEAD', 'PROPFIND', 'MKCOL', undefined])(
        'leaves %s on the default redirect policy',
        async (method) => {
            let receivedInit: RequestInit | undefined;

            await fetchWithTimeout(
                'https://dav.example.com/data.json',
                method === undefined ? {} : { method },
                1_000,
                async (_input, init) => {
                    receivedInit = init;
                    return new Response(null, { status: 200 });
                },
                'Request timed out',
            );

            expect(receivedInit?.redirect).toBeUndefined();
        },
    );

    it('preserves nested transport causes for fetch failures', async () => {
        const certificateError = new Error('invalid peer certificate: UnknownIssuer');
        const connectError = new Error('client error (Connect)');
        (connectError as Error & { cause?: unknown }).cause = certificateError;
        const requestError = new Error('error sending request for url (https://files.internal/mindwtr/attachments/)');
        (requestError as Error & { cause?: unknown }).cause = connectError;

        await expect(fetchWithTimeout(
            'https://files.internal/mindwtr/attachments/',
            { method: 'MKCOL' },
            1_000,
            async () => {
                throw requestError;
            },
            'Request timed out',
        )).rejects.toThrow(
            'error sending request for url (https://files.internal/mindwtr/attachments/) (caused by: client error (Connect) -> invalid peer certificate: UnknownIssuer)',
        );
    });
});

describe('readResponseBody', () => {
    const streamingResponse = (
        chunks: Uint8Array[],
        headers: Record<string, string> = {},
    ) => {
        const read = vi.fn(async () => {
            const value = chunks.shift();
            return value ? { done: false, value } : { done: true, value: undefined };
        });
        const cancel = vi.fn(async () => {});
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        const res = {
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            body: { locked: false, cancel, getReader: () => ({ read, cancel }) },
            arrayBuffer,
        } as unknown as Response;
        return { res, read, cancel, arrayBuffer };
    };

    it('caps downloads at twice the attachment upload limit', () => {
        expect(MAX_DOWNLOAD_BYTES).toBe(2 * DEFAULT_MAX_FILE_SIZE_BYTES);
    });

    it('rejects a huge content-length before reading a single byte', async () => {
        const { res, read, cancel, arrayBuffer } = streamingResponse([new Uint8Array([1, 2, 3])], {
            'content-length': String(MAX_DOWNLOAD_BYTES + 1),
        });
        await expect(readResponseBody(res)).rejects.toBeInstanceOf(ResponseTooLargeError);
        await expect(readResponseBody(res)).rejects.toThrow(String(MAX_DOWNLOAD_BYTES));
        expect(read).not.toHaveBeenCalled();
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
    });

    it('aborts a body that streams past the cap despite an honest-looking header', async () => {
        const chunk = new Uint8Array(64);
        const chunks = Array.from({ length: 10 }, () => chunk);
        const { res, cancel } = streamingResponse(chunks, { 'content-length': '64' });
        await expect(readResponseBody(res, undefined, 256)).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(cancel).toHaveBeenCalled();
    });

    it('aborts a body with no content-length header at all', async () => {
        const chunks = Array.from({ length: 10 }, () => new Uint8Array(64));
        const { res, cancel } = streamingResponse(chunks);
        await expect(readResponseBody(res, undefined, 256)).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(cancel).toHaveBeenCalled();
    });

    it('returns the streamed bytes and reports progress unchanged', async () => {
        const { res } = streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3])], {
            'content-length': '3',
        });
        const onProgress = vi.fn();
        const buffer = await readResponseBody(res, onProgress);
        expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3]);
        expect(onProgress.mock.calls).toEqual([[2, 3], [3, 3]]);
    });

    it('falls back to arrayBuffer when the body is not readable', async () => {
        const res = {
            headers: { get: () => null },
            arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
        } as unknown as Response;
        expect(Array.from(new Uint8Array(await readResponseBody(res)))).toEqual([7, 8]);
    });

    it('rejects an oversized arrayBuffer fallback', async () => {
        const res = {
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(512),
        } as unknown as Response;
        await expect(readResponseBody(res, undefined, 256)).rejects.toBeInstanceOf(ResponseTooLargeError);
    });
});
