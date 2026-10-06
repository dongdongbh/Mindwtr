import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchWithTimeout,
    fetchWithTimeoutAndConsume,
    isAllowedInsecureUrl,
    isConnectionAllowed,
    isHostResponseTooLargeError,
    MAX_DOWNLOAD_BYTES,
    readResponseBody,
    ResponseTooLargeError,
    SUSPENDED_REQUEST_MESSAGE,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
} from './http-utils';
import { DEFAULT_MAX_FILE_SIZE_BYTES } from './attachment-validation';
import { consoleLogger, setLogger, type LogPayload } from './logger';

describe('isHostResponseTooLargeError', () => {
    it('recognizes the native Error fields without relying on name or message', () => {
        expect(isHostResponseTooLargeError(Object.assign(new TypeError('unrelated message'), {
            code: 'response-too-large', limitBytes: 8 * 1024 * 1024,
        }))).toBe(true);
        expect(isHostResponseTooLargeError(Object.assign(new Error('network timeout'), {
            code: 'response-too-large', limitBytes: Number.MAX_SAFE_INTEGER,
        }))).toBe(true);
    });

    it.each([undefined, null, '8', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'refuses malformed native limit %s', (limitBytes) => {
            expect(isHostResponseTooLargeError(Object.assign(new TypeError('Response exceeds the limit'), {
                code: 'response-too-large', limitBytes,
            }))).toBe(false);
        },
    );

    it('refuses ordinary RN limits, plain objects, names, messages, and unknown codes', () => {
        expect(isHostResponseTooLargeError(new ResponseTooLargeError(8))).toBe(false);
        expect(isHostResponseTooLargeError({ code: 'response-too-large', limitBytes: 8 })).toBe(false);
        expect(isHostResponseTooLargeError(Object.assign(new Error('Response exceeds the 8 byte download limit'), {
            name: 'ResponseTooLargeError', limitBytes: 8,
        }))).toBe(false);
        expect(isHostResponseTooLargeError(Object.assign(new Error('refused'), {
            code: 'RESPONSE_TOO_LARGE', limitBytes: 8,
        }))).toBe(false);
        expect(isHostResponseTooLargeError(null)).toBe(false);
    });

    it('preserves the original structured fetch refusal through the timeout consumer', async () => {
        const error = Object.assign(new TypeError('Response exceeds the 8 byte download limit'), {
            code: 'response-too-large', limitBytes: 8,
        });
        const consume = vi.fn();
        await expect(fetchWithTimeoutAndConsume('https://example.com/file', {}, 1000,
            vi.fn().mockRejectedValue(error), 'timed out', consume)).rejects.toBe(error);
        expect(consume).not.toHaveBeenCalled();
    });
});

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

    it('cancels an unlocked response body when a status-only consumer returns normally', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 404 });

        await expect(fetchWithTimeoutAndConsume(
            'https://example.com/missing.json',
            {},
            1_000,
            async () => response,
            'Request timed out',
            async (res) => res.status === 404 ? null : 'unexpected',
        )).resolves.toBeNull();

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

    it.each([301, 302, 303, 307, 308])(
        'refuses a %s a fetcher handed back unfollowed on a write, like undici does',
        async (status) => {
            // React Native ignores `redirect`; its Android client returns the redirect
            // unfollowed instead of turning the PUT into a GET.
            const logs: LogPayload[] = [];
            setLogger((payload) => { logs.push(payload); });
            try {
                await expect(fetchWithTimeoutAndConsume(
                    'https://user:secret@dav.example.com/data.json',
                    { method: 'PUT', body: '{"tasks":[]}' },
                    1_000,
                    async () => new Response(null, { status }),
                    'Request timed out',
                    () => 'written',
                )).rejects.toThrow('fetch failed: unexpected redirect');
            } finally {
                setLogger(consoleLogger);
            }
            expect(logs).toEqual([expect.objectContaining({
                level: 'warn',
                context: { releaseCheck: 'v1.3.3/fetch-redirect-refused', method: 'PUT', status },
            })]);
            expect(JSON.stringify(logs)).not.toContain('secret');
        },
    );

    const answeredFrom = (url: string, status = 200) => {
        const response = new Response(null, { status });
        Object.defineProperty(response, 'url', { value: url });
        return response;
    };

    it.each([
        ['http://dav.example.com/dav/data.json', 'https://dav.example.com/dav/data.json'],
        ['https://dav.example.com/dav/data.json', 'https://files.example.net/dav/data.json'],
        ['https://dav.example.com/dav/data.json', 'https://dav.example.com:8443/dav/data.json'],
        ['https://dav.example.com/dav/data.json', 'https://dav.example.com/dav/data.json/'],
        ['https://dav.example.com/dav/data.json', 'https://dav.example.com/login?next=%2Fdav'],
        ['https://bücher.example/dav/data.json', 'https://dav.example.com/dav/data.json'],
        ['https://[2001:db8::1]/dav/data.json', 'https://[2001:db8::2]/dav/data.json'],
        ['https://dav.example.com/dav/data.json', 'https://dav.example.com:80/dav/data.json'],
        ['https://xn--bcher-kva.example/dav/data.json', 'https://xn--mnchen-3ya.example/dav/data.json'],
        ['https://bücher.example/dav/data.json', 'https://xn--mnchen-3ya.example/dav/data.json'],
        ['https://dav.example.com/dav/a%2Fb.json', 'https://dav.example.com/dav/a/b.json'],
        ['https://cloud.example.com/v1/data?a=1%26b=2', 'https://cloud.example.com/v1/data?a=1&b=2'],
        ['https://[::ffff:192.168.1.5]/dav/data.json', 'https://192.168.1.6/dav/data.json'],
        ['http://127.1/dav/data.json', 'http://127.0.0.2/dav/data.json'],
        ['https://%62ucher.example/dav/data.json', 'https://cucher.example/dav/data.json'],
        ['https://cloud.example.com/v1/data?a=%5C', 'https://cloud.example.com/v1/data?a=/'],
    ])('refuses a write to %s that iOS followed to %s', async (requested, answered) => {
        // React Native on iOS follows a write redirect (a 303 as a GET) and hands back
        // the final answer; only the URL it came from tells.
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        try {
            await expect(fetchWithTimeoutAndConsume(
                requested,
                { method: 'PUT', body: '{"tasks":[]}' },
                1_000,
                async () => answeredFrom(answered),
                'Request timed out',
                () => 'written',
            )).rejects.toThrow('fetch failed: unexpected redirect');
        } finally {
            setLogger(consoleLogger);
        }
        expect(logs).toEqual([expect.objectContaining({
            level: 'warn',
            context: { releaseCheck: 'v1.3.4/fetch-redirect-refused-ios', method: 'PUT', status: 200 },
        })]);
        expect(JSON.stringify(logs)).not.toContain('example');
    });

    it.each([
        ['https://dav.example.com/dav/My File.json', 'https://DAV.Example.com:443/dav/My%20File.json'],
        ['http://192.168.1.5:80/dav/data.json', 'http://192.168.1.5/dav/data.json'],
        ['https://user:secret@dav.example.com/dav/data.json', 'https://dav.example.com/dav/data.json'],
        ['https://dav.example.com/dav/a|b%7c.json', 'https://dav.example.com/dav/a%7Cb%7C.json'],
        ['https://dav.example.com/dav/./x/../data.json#top', 'https://dav.example.com/dav/data.json'],
        ['https://dav.example.com', 'https://dav.example.com/'],
        ['https://dav.example.com/dav/data.json?', 'https://dav.example.com/dav/data.json'],
        ['https://bücher.example/dav/data.json', 'https://xn--bcher-kva.example/dav/data.json'],
        ['https://[fd00::1]:443/dav/data.json', 'https://[FD00::1]/dav/data.json'],
        ['https://[2001:0db8:0:0:0:0:0:1]/dav/data.json', 'https://[2001:db8::1]/dav/data.json'],
        ['https://[::ffff:192.168.1.5]:8443/dav/data.json', 'https://[::ffff:c0a8:105]:8443/dav/data.json'],
        ['https://[fe80::1%25en0]/dav/data.json', 'https://[FE80:0:0:0:0:0:0:1%25en0]/dav/data.json'],
        ['https://dav.example.com:0443/dav/data.json', 'https://dav.example.com/dav/data.json'],
        ['http://nas.local:08080/dav/data.json', 'http://nas.local:8080/dav/data.json'],
        ['https://BÜCHER.example/dav/data.json', 'https://xn--bcher-kva.example/dav/data.json'],
        ['https://dav.example.com/dav/%7euser/data.json', 'https://dav.example.com/dav/~user/data.json'],
        ['https://dav.example.com/dav/%e6%97%a5.json', 'https://dav.example.com/dav/日.json'],
        ['https://dav.example.com/dav/50%.json', 'https://dav.example.com/dav/50%25.json'],
        ['https://dav.example.com/dav/[x] {y}^.json', 'https://dav.example.com/dav/%5Bx%5D%20%7By%7D%5E.json'],
        ['https://[::ffff:192.168.1.5]:8443/dav/data.json', 'https://192.168.1.5:8443/dav/data.json'],
        ['http://127.1/dav/data.json', 'http://127.0.0.1/dav/data.json'],
        ['http://10.1.5/dav/data.json', 'http://10.1.0.5/dav/data.json'],
        ['http://0x7f.0.0.1/dav/data.json', 'http://127.0.0.1/dav/data.json'],
        ['http://0177.0.0.01/dav/data.json', 'http://127.0.0.1/dav/data.json'],
        ['http://2130706433/dav/data.json', 'http://127.0.0.1/dav/data.json'],
        ['https://%62ucher.example/dav/data.json', 'https://bucher.example/dav/data.json'],
        ['https://%C3%BCber.example/dav/data.json', 'https://xn--ber-goa.example/dav/data.json'],
        ['https://dav.example.com/dav\\a\\b.json', 'https://dav.example.com/dav/a/b.json'],
        ['https://dav.example.com\\dav/data.json', 'https://dav.example.com/dav/data.json'],
        ['https://dav.example.com/dav/data.json', ''],
    ])('accepts a write to %s answered from %s, the same URL', async (requested, answered) => {
        // OkHttp (Android) and NSURL (iOS) report a URL they did not redirect in their
        // own spelling; that must never read as a redirect.
        await expect(fetchWithTimeoutAndConsume(
            requested,
            { method: 'PUT', body: '{"tasks":[]}' },
            1_000,
            async () => answeredFrom(answered, 201),
            'Request timed out',
            () => 'written',
        )).resolves.toBe('written');
    });

    // RFC 3492 section 7.1 samples B, C, D, K and L, as lowercase host labels.
    it.each([
        ['他们为什么不说中文', 'ihqwcrb4cv8a8dqg056pqjye'],
        ['他們爲什麽不說中文', 'ihqwctvzc91f659drss3x8bo0yb'],
        ['pročprostěnemluvíčesky', 'proprostnemluvesky-uyb24dma41a'],
        ['tạisaohọkhôngthểchỉnóitiếngviệt', 'tisaohkhngthchnitingvit-kjcr8268qyxafd2f1b9g'],
        ['3年b組金八先生', '3b-ww4c5e180e575a65lsy2b'],
        ['münchen', 'mnchen-3ya'],
    ])('reads the host %s as its punycode xn--%s', async (label, punycode) => {
        const write = (answered: string) => fetchWithTimeoutAndConsume(
            `https://${label}.example/dav/data.json`,
            { method: 'PUT', body: '{}' },
            1_000,
            async () => answeredFrom(answered, 201),
            'Request timed out',
            () => 'written',
        );
        await expect(write(`https://xn--${punycode}.example/dav/data.json`)).resolves.toBe('written');
        await expect(write(`https://xn--${punycode}x.example/dav/data.json`)).rejects.toThrow('fetch failed: unexpected redirect');
    });

    it.each([
        ['a 200,000-character host label', `https://${'ü'.repeat(200_000)}.example/dav/data.json`, 'https://other.example/dav/data.json'],
        ['a lone surrogate the client replaced', 'https://dav.example.com/dav/\uD800.json', 'https://dav.example.com/dav/%EF%BF%BD.json'],
        ['a lone surrogate in the host', 'https://dav\uDC00.example.com/dav/data.json', 'https://dav\uFFFD.example.com/dav/data.json'],
    ])('lets a write through when %s leaves the URLs impossible to compare', async (_case, requested, answered) => {
        // The check must never throw and never refuse on a URL it cannot read.
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        try {
            await expect(fetchWithTimeoutAndConsume(
                requested,
                { method: 'PUT', body: '{}' },
                1_000,
                async () => answeredFrom(answered, 201),
                'Request timed out',
                () => 'written',
            )).resolves.toBe('written');
        } finally {
            setLogger(consoleLogger);
        }
        expect(logs).toEqual([expect.objectContaining({
            level: 'warn',
            message: 'Write redirect check skipped: a URL could not be compared',
        })]);
        expect(JSON.stringify(logs)).not.toContain('example');
    });

    it('refuses an Android redirect once, with its own line', async () => {
        // Android's interceptor hands the 3xx back from the URL asked for; the answering
        // URL check must neither refuse it a second time nor claim it was followed.
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        try {
            await expect(fetchWithTimeoutAndConsume(
                'https://dav.example.com/dav/My File.json',
                { method: 'DELETE' },
                1_000,
                async () => answeredFrom('https://dav.example.com/dav/My%20File.json', 301),
                'Request timed out',
                () => 'deleted',
            )).rejects.toThrow('fetch failed: unexpected redirect');
        } finally {
            setLogger(consoleLogger);
        }
        expect(logs).toEqual([expect.objectContaining({
            context: { releaseCheck: 'v1.3.3/fetch-redirect-refused', method: 'DELETE', status: 301 },
        })]);
    });

    it('lets a read answered from another URL through', async () => {
        await expect(fetchWithTimeoutAndConsume(
            'http://dav.example.com/dav/data.json',
            { method: 'GET' },
            1_000,
            async () => answeredFrom('https://dav.example.com/dav/data.json'),
            'Request timed out',
            (response) => response.status,
        )).resolves.toBe(200);
    });

    it('hands a redirect status back to a read, which keeps the default policy', async () => {
        await expect(fetchWithTimeoutAndConsume(
            'https://dav.example.com/data.json',
            { method: 'GET' },
            1_000,
            async () => new Response(null, { status: 301 }),
            'Request timed out',
            (response) => response.status,
        )).resolves.toBe(301);
    });

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


describe('fetchWithTimeoutAndConsume suspension detection', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const neverResolving: typeof fetch = () => new Promise(() => undefined);

    it('reports a plain timeout when the timer fires on schedule', async () => {
        vi.useFakeTimers();
        const pending = fetchWithTimeoutAndConsume('https://example.com/x', {}, 1_000, neverResolving, 'Cloud request timed out', async () => 'ok');
        const outcome = expect(pending).rejects.toThrow(/^Cloud request timed out$/);
        await vi.advanceTimersByTimeAsync(1_000);
        await outcome;
    });

    it('marks a timer that fired hours late as an interruption while the app was suspended', async () => {
        // Android froze the process with the request in flight (#1139): the
        // timer fired 62 minutes later, when the app was thawed.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-02T07:00:15.000Z'));
        const pending = fetchWithTimeoutAndConsume('https://example.com/x', {}, 1_000, neverResolving, 'Cloud request timed out', async () => 'ok');
        const outcome = expect(pending).rejects.toThrow(new RegExp(`^Cloud request timed out; ${SUSPENDED_REQUEST_MESSAGE}$`));
        vi.setSystemTime(new Date('2026-09-02T08:03:04.000Z'));
        await vi.advanceTimersByTimeAsync(1_000);
        await outcome;
    });
});
