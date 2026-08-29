import { describe, expect, it, vi } from 'vitest';
import {
    __webdavTestUtils,
    assertWebdavStrongEtagSupport,
    probeWebdavSyncCompatibility,
    webdavDeleteFile,
    webdavDeleteFileVersioned,
    webdavGetFile,
    webdavGetFileVersioned,
    webdavGetJson,
    webdavHeadFile,
    webdavPutFile,
    webdavPutFileVersioned,
    webdavPutJson,
} from './webdav';
import { MAX_DOWNLOAD_BYTES, MAX_ERROR_BODY_BYTES, ResponseTooLargeError } from './http-utils';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { SyncEncryptionRemoteVersionUnavailableError } from './sync-encryption';

const makeResponse = (overrides: Partial<Response> & { status: number; ok: boolean }): Response => ({
    statusText: '',
    headers: {
        get: () => null,
    } as unknown as Headers,
    text: async () => '',
    ...overrides,
}) as Response;

const createWebdavCapabilityFetcher = (
    documentUrl: string,
    options: {
        documentBody?: string;
        ignoreCreateOnly?: boolean;
        ignoreStaleDelete?: boolean;
        ignoreStaleMatch?: boolean;
        rejectCurrentDelete?: boolean;
    } = {},
) => {
    const requests: { method: string; url: string; headers: Headers }[] = [];
    let probeUrl = '';
    let probeBytes: Uint8Array | null = null;
    let probeVersion = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        requests.push({ method, url, headers });

        if (url === documentUrl && method === 'GET') {
            if (options.documentBody === undefined) return new Response(null, { status: 404 });
            return new Response(options.documentBody, { status: 200, headers: { etag: '"document-v1"' } });
        }
        probeUrl ||= url;
        if (url !== probeUrl) throw new Error(`unexpected probe URL ${url}`);

        if (method === 'GET') {
            if (!probeBytes) return new Response(null, { status: 404 });
            return new Response(probeBytes, {
                status: 200,
                headers: { etag: `"probe-v${probeVersion}"` },
            });
        }
        if (method === 'PUT') {
            const body = init?.body;
            if (!(body instanceof Uint8Array)) throw new Error('expected a byte-array probe body');
            const ifNoneMatch = headers.get('if-none-match');
            const ifMatch = headers.get('if-match');
            const currentEtag = probeBytes ? `"probe-v${probeVersion}"` : null;
            if (probeBytes && ifNoneMatch === '*' && !options.ignoreCreateOnly) {
                return new Response(null, { status: 412 });
            }
            if (
                probeBytes
                && ifMatch
                && ifMatch !== currentEtag
                && !options.ignoreStaleMatch
            ) {
                return new Response(null, { status: 412 });
            }
            probeBytes = new Uint8Array(body);
            probeVersion += 1;
            return new Response(null, { status: currentEtag ? 204 : 201 });
        }
        if (method === 'DELETE') {
            const currentEtag = probeBytes ? `"probe-v${probeVersion}"` : null;
            const ifMatch = headers.get('if-match');
            if (!probeBytes || (ifMatch !== currentEtag && !options.ignoreStaleDelete)) {
                return new Response(null, { status: 412 });
            }
            if (ifMatch === currentEtag && options.rejectCurrentDelete) {
                return new Response(null, { status: 405 });
            }
            probeBytes = null;
            return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${method}`);
    }) as unknown as typeof fetch;
    return { fetcher, getProbeUrl: () => probeUrl, requests };
};

describe('webdav http helpers', () => {
    it('allows HTTP for private IP targets', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    text: async () => '',
                }) as Response,
        );

        await expect(webdavGetJson('http://100.64.10.2/dav/data.json', { fetcher })).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('allows HTTP for local hostnames', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    text: async () => '',
                }) as Response,
        );

        await expect(webdavGetJson('http://nas.local/dav/data.json', { fetcher })).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('rejects Nextcloud web-UI URLs with an actionable message', async () => {
        const fetcher = vi.fn();
        await expect(
            webdavGetJson('https://cloud.example.com/apps/files/files/6538200/data.json?dir=%2FMindwtr', { fetcher }),
        ).rejects.toThrow('not a WebDAV address');
        await expect(
            webdavGetJson('https://cloud.example.com/index.php/apps/files/data.json', { fetcher }),
        ).rejects.toThrow('not a WebDAV address');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('accepts real Nextcloud WebDAV endpoints', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    text: async () => '',
                }) as Response,
        );
        await expect(
            webdavGetJson('https://cloud.example.com/remote.php/dav/files/user/Mindwtr/data.json', { fetcher }),
        ).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('rejects HTTP for public targets', async () => {
        const fetcher = vi.fn();
        await expect(webdavGetJson('http://8.8.8.8/dav/data.json', { fetcher })).rejects.toThrow(
            'WebDAV requires HTTPS for public URLs',
        );
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('honors explicit insecure HTTP overrides for public targets', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    text: async () => '',
                }) as Response,
        );

        await expect(
            webdavGetJson('http://8.8.8.8/dav/data.json', {
                fetcher,
                allowInsecureHttp: true,
            }),
        ).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('treats empty successful body as missing remote data', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    text: async () => '   ',
                }) as Response,
        );

        await expect(webdavGetJson<{ foo: string }>('https://example.com/data.json', { fetcher })).resolves.toBeNull();
    });

    it('parses JSON body with a UTF-8 BOM prefix', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    text: async () => '\uFEFF{"ok":true}',
                }) as Response,
        );

        await expect(webdavGetJson<{ ok: boolean }>('https://example.com/data.json', { fetcher })).resolves.toEqual({ ok: true });
    });

    it('bypasses HTTP caches for JSON and metadata reads without URL cache busting', async () => {
        const getFetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    text: async () => '{"ok":true}',
                }) as Response,
        );

        await expect(webdavGetJson<{ ok: boolean }>('https://example.com/data.json', { fetcher: getFetcher })).resolves.toEqual({ ok: true });
        expect(getFetcher.mock.calls[0]?.[1]).toMatchObject({
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
            },
        });
        expect(getFetcher.mock.calls[0]?.[1]).not.toHaveProperty('cache');

        const headFetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string) => ({
                            etag: '"rev-1"',
                        }[name.toLowerCase()] ?? null),
                    },
                    text: async () => '',
                }) as unknown as Response,
        );

        await expect(webdavHeadFile('https://example.com/data.json', { fetcher: headFetcher })).resolves.toMatchObject({
            exists: true,
            fingerprint: 'webdav:v1:etag="rev-1"',
        });
        expect(headFetcher.mock.calls[0]?.[1]).toMatchObject({
            method: 'HEAD',
            headers: {
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
            },
        });
        expect(headFetcher.mock.calls[0]?.[1]).not.toHaveProperty('cache');
    });

    it('reads HEAD metadata for fast sync checks', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string) => ({
                            etag: '"rev-1"',
                            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
                            'content-length': '42',
                        }[name.toLowerCase()] ?? null),
                    },
                    text: async () => '',
                }) as unknown as Response,
        );

        await expect(webdavHeadFile('https://example.com/data.json', { fetcher })).resolves.toMatchObject({
            exists: true,
            fingerprint: 'webdav:v1:etag="rev-1"',
            etag: '"rev-1"',
            contentLength: '42',
        });
        expect(fetcher.mock.calls[0]?.[1]?.method).toBe('HEAD');
    });

    it('falls back to last-modified and length for ETag-less fast sync checks with a warning', async () => {
        __webdavTestUtils.resetWeakFingerprintWarnings();
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string) => ({
                            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
                            'content-length': '42',
                        }[name.toLowerCase()] ?? null),
                    },
                    text: async () => '',
                }) as unknown as Response,
        );
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));

        try {
            await expect(webdavHeadFile('https://example.com/data.json', { fetcher })).resolves.toMatchObject({
                exists: true,
                fingerprint: 'webdav:v1:mtime=Thu, 07 May 2026 10:00:00 GMT:len=42',
                etag: null,
                lastModified: 'Thu, 07 May 2026 10:00:00 GMT',
                contentLength: '42',
            });
            await webdavHeadFile('https://example.com/data.json', { fetcher });
        } finally {
            setLogger(consoleLogger);
            __webdavTestUtils.resetWeakFingerprintWarnings();
        }

        expect(logs.filter((entry) => entry.level === 'warn' && entry.message.includes('did not provide ETag'))).toHaveLength(1);
    });

    it('warns once per WebDAV URL when using weak ETag-less fingerprints', async () => {
        __webdavTestUtils.resetWeakFingerprintWarnings();
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string) => ({
                            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
                            'content-length': '42',
                        }[name.toLowerCase()] ?? null),
                    },
                    text: async () => '',
                }) as unknown as Response,
        );
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));

        try {
            await webdavHeadFile('https://EXAMPLE.com/alice/data.json/', { fetcher });
            await webdavHeadFile('https://example.com/alice/data.json', { fetcher });
            await webdavHeadFile('https://example.com/bob/data.json', { fetcher });
        } finally {
            setLogger(consoleLogger);
            __webdavTestUtils.resetWeakFingerprintWarnings();
        }

        expect(logs.filter((entry) => entry.level === 'warn' && entry.message.includes('did not provide ETag'))).toHaveLength(2);
    });

    it('can disable weak ETag-less fast sync fingerprints', async () => {
        const fetcher = vi.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string) => ({
                            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
                            'content-length': '42',
                        }[name.toLowerCase()] ?? null),
                    },
                    text: async () => '',
                }) as unknown as Response,
        );

        await expect(webdavHeadFile('https://example.com/data.json', { fetcher, allowWeakFingerprint: false })).resolves.toMatchObject({
            exists: true,
            fingerprint: null,
            etag: null,
            lastModified: 'Thu, 07 May 2026 10:00:00 GMT',
            contentLength: '42',
        });
    });

    it('creates missing parent collections before retrying a JSON PUT', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, statusText: 'Not Found' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }));

        await expect(
            webdavPutJson('https://example.com/remote.php/dav/files/user/mindwtr/nested/data.json', { ok: true }, { fetcher }),
        ).resolves.toMatchObject({ exists: true, fingerprint: null });

        expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-NC-WebDAV-AutoMkcol': '1' });
        expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
            ['https://example.com/remote.php/dav/files/user/mindwtr/nested/data.json', 'PUT'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/nested/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/nested/', 'PROPFIND'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/nested/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/nested/data.json', 'PUT'],
        ]);
    });

    it('returns JSON PUT response metadata for fast sync recording', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(makeResponse({
            ok: true,
            status: 204,
            statusText: 'No Content',
            headers: {
                get: (name: string) => ({
                    etag: '"put-rev"',
                }[name.toLowerCase()] ?? null),
            } as unknown as Headers,
        }));

        await expect(
            webdavPutJson('https://example.com/mindwtr/data.json', { ok: true }, { fetcher }),
        ).resolves.toMatchObject({
            exists: true,
            fingerprint: 'webdav:v1:etag="put-rev"',
            etag: '"put-rev"',
        });
    });

    it('creates missing parent collections before retrying a file PUT', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }));

        await expect(
            webdavPutFile(
                'https://example.com/remote.php/dav/files/user/mindwtr/attachments/doc.txt',
                new Uint8Array([1, 2, 3]),
                'text/plain',
                { fetcher },
            ),
        ).resolves.toBeUndefined();

        expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-NC-WebDAV-AutoMkcol': '1' });
        expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
            ['https://example.com/remote.php/dav/files/user/mindwtr/attachments/doc.txt', 'PUT'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/attachments/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/attachments/doc.txt', 'PUT'],
        ]);
    });

    it('recovers when a WebDAV server reports 409 for MKCOL on an existing parent collection', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, statusText: 'Not Found' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 207, statusText: 'Multi-Status' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }));

        await expect(
            webdavPutJson('https://example.com/remote.php/dav/files/user/mindwtr/data.json', { ok: true }, { fetcher }),
        ).resolves.toMatchObject({ exists: true, fingerprint: null });

        expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
            ['https://example.com/remote.php/dav/files/user/mindwtr/data.json', 'PUT'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/', 'PROPFIND'],
            ['https://example.com/remote.php/dav/files/user/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/', 'PROPFIND'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/', 'MKCOL'],
            ['https://example.com/remote.php/dav/files/user/mindwtr/data.json', 'PUT'],
        ]);
        expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({ Depth: '0' });
        expect(fetcher.mock.calls[4]?.[1]?.headers).toMatchObject({ Depth: '0' });
    });

    it('retries a JSON PUT after an unverified MKCOL conflict', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 403, statusText: 'Forbidden' }))
            .mockResolvedValueOnce(makeResponse({ ok: true, status: 201, statusText: 'Created' }));

        await expect(
            webdavPutJson('https://example.com/mindwtr/data.json', { ok: true }, { fetcher }),
        ).resolves.toMatchObject({ exists: true, fingerprint: null });

        expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
            ['https://example.com/mindwtr/data.json', 'PUT'],
            ['https://example.com/mindwtr/', 'MKCOL'],
            ['https://example.com/mindwtr/', 'PROPFIND'],
            ['https://example.com/mindwtr/data.json', 'PUT'],
        ]);
    });

    it('reports the final PUT failure after an unverified MKCOL conflict', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 403, statusText: 'Forbidden' }))
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'Conflict' }));

        await expect(
            webdavPutJson('https://example.com/mindwtr/data.json', { ok: true }, { fetcher }),
        ).rejects.toThrow('WebDAV PUT failed (409): Conflict');
    });

    it('times out and cancels a stalled JSON PUT error body after response headers', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 });

        await expect(webdavPutJson(
            'https://example.com/mindwtr/data.json',
            { ok: true },
            { fetcher: async () => response, timeoutMs: 1 },
        )).rejects.toThrow('WebDAV request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('caps parent MKCOL creation depth for pathological nested paths', async () => {
        const nestedSegments = Array.from({ length: 40 }, (_, index) => `level-${index + 1}`).join('/');
        const url = `https://example.com/remote.php/dav/files/user/mindwtr/${nestedSegments}/data.json`;
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(makeResponse({ ok: false, status: 409, statusText: 'Conflict' }))
            .mockImplementation(async () => makeResponse({ ok: false, status: 409, statusText: 'Conflict' }));

        await expect(webdavPutJson(url, { ok: true }, { fetcher })).rejects.toThrow(
            'WebDAV MKCOL failed (max depth exceeded)',
        );

        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'MKCOL')).toHaveLength(33);
    });
});

describe('webdavGetFile download cap', () => {
    const fileResponse = (chunks: Uint8Array[], headers: Record<string, string>) => {
        const read = vi.fn(async () => {
            const value = chunks.shift();
            return value ? { done: false, value } : { done: true, value: undefined };
        });
        const res = makeResponse({
            ok: true,
            status: 200,
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } as unknown as Headers,
            body: { getReader: () => ({ read, cancel: async () => {} }) } as unknown as ReadableStream<Uint8Array>,
            arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
        });
        return { res, read };
    };

    it('rejects a hostile content-length without reading the body', async () => {
        const { res, read } = fileResponse([new Uint8Array([1])], {
            'content-length': String(MAX_DOWNLOAD_BYTES + 1),
        });
        await expect(
            webdavGetFile('https://example.com/dav/a.bin', { fetcher: async () => res }),
        ).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(read).not.toHaveBeenCalled();
    });

    it('still streams a normal download and reports progress', async () => {
        const { res } = fileResponse([new Uint8Array([4, 5]), new Uint8Array([6])], {
            'content-length': '3',
        });
        const onProgress = vi.fn();
        const buffer = await webdavGetFile('https://example.com/dav/a.bin', {
            fetcher: async () => res,
            onProgress,
        });
        expect(Array.from(new Uint8Array(buffer))).toEqual([4, 5, 6]);
        expect(onProgress.mock.calls).toEqual([[2, 3], [3, 3]]);
    });

    it('times out and cancels a download body that stalls after headers', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });

        await expect(webdavGetFile('https://example.com/dav/a.bin', {
            fetcher: async () => response,
            timeoutMs: 1,
        })).rejects.toThrow('WebDAV request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);
});

describe('versioned WebDAV transition byte operations', () => {
    it('returns bytes and the strong ETag from one GET, and distinguishes missing', async () => {
        const found = await webdavGetFileVersioned('https://example.com/dav/a.bin', {
            fetcher: async () => new Response(new Uint8Array([1, 2]), {
                status: 200,
                headers: { etag: '"v1"' },
            }),
        });
        expect(found).toEqual({ bytes: new Uint8Array([1, 2]), version: '"v1"' });

        await expect(webdavGetFileVersioned('https://example.com/dav/a.bin', {
            fetcher: async () => new Response(null, { status: 404 }),
        })).resolves.toEqual({ bytes: null, version: null });
    });

    it.each([
        ['missing', null],
        ['weak', 'W/"v1"'],
    ])('returns existing bytes with no safe version for a %s ETag', async (_case, etag) => {
        await expect(webdavGetFileVersioned('https://example.com/dav/a.bin', {
            fetcher: async () => new Response(new Uint8Array([1, 2]), {
                status: 200,
                headers: etag ? { etag } : undefined,
            }),
        })).resolves.toEqual({ bytes: new Uint8Array([1, 2]), version: null });
    });

    it('preserves create-only headers across MKCOL retry', async () => {
        const putHeaders: Headers[] = [];
        let putCount = 0;
        const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'PUT') {
                putHeaders.push(new Headers(init?.headers));
                putCount += 1;
                return new Response(null, { status: putCount === 1 ? 409 : 201 });
            }
            if (method === 'MKCOL') return new Response(null, { status: 201 });
            throw new Error(`unexpected ${method}`);
        }) as unknown as typeof fetch;

        await webdavPutFileVersioned(
            'https://example.com/dav/a.bin', new Uint8Array([1]), 'application/octet-stream', null, { fetcher },
        );
        expect(putHeaders).toHaveLength(2);
        expect(putHeaders.every((headers) => headers.get('if-none-match') === '*')).toBe(true);
    });

    it('uses If-Match for delete and maps a stale generation to conflict', async () => {
        const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('if-match')).toBe('"v1"');
            return new Response(null, { status: 412 });
        }) as unknown as typeof fetch;

        await expect(webdavDeleteFileVersioned(
            'https://example.com/dav/a.bin', '"v1"', { fetcher },
        )).rejects.toThrow('WEBDAV_REMOTE_WRITE_CONFLICT');
    });

    it.each([
        ['PUT', (fetcher: typeof fetch) => webdavPutFile(
            'https://example.com/dav/a.bin', new Uint8Array([1]), 'application/octet-stream',
            { fetcher, timeoutMs: 1 },
        )],
        ['DELETE', (fetcher: typeof fetch) => webdavDeleteFile(
            'https://example.com/dav/a.bin', { fetcher, timeoutMs: 1 },
        )],
    ])('times out and cancels a stalled successful %s response body', async (_kind, request) => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });

        await expect(request(async () => response)).rejects.toThrow('WebDAV request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('preflights an empty remote with enforced create-only and stale replacement conditions', async () => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher, getProbeUrl, requests } = createWebdavCapabilityFetcher(documentUrl);

        await assertWebdavStrongEtagSupport(documentUrl, { fetcher });

        expect(requests.map(({ method }) => method)).toEqual([
            'GET', 'PUT', 'GET', 'PUT', 'PUT', 'GET', 'PUT', 'DELETE', 'GET', 'DELETE',
        ]);
        expect(requests[1]?.headers.get('if-none-match')).toBe('*');
        expect(requests[3]?.headers.get('if-none-match')).toBe('*');
        expect(requests[4]?.headers.get('if-match')).toBe('"probe-v1"');
        expect(requests[6]?.headers.get('if-match')).toBe('"probe-v1"');
        expect(requests[7]?.headers.get('if-match')).toBe('"probe-v1"');
        expect(requests[9]?.headers.get('if-match')).toBe('"probe-v2"');
        expect(getProbeUrl()).toContain('data.json.mindwtr-etag-probe-');
    });

    it.each([
        ['missing', null],
        ['weak', 'W/"legacy-v1"'],
    ])('recognizes a valid plaintext document with a %s ETag as legacy-compatible without writing', async (_case, etag) => {
        const requests: string[] = [];
        const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init?.method ?? 'GET');
            return new Response('{"tasks":[]}', {
                status: 200,
                headers: etag ? { etag } : undefined,
            });
        }) as unknown as typeof fetch;

        await expect(probeWebdavSyncCompatibility(
            'https://example.com/dav/data.json',
            { fetcher },
        )).resolves.toBe('legacy-plaintext');
        expect(requests).toEqual(['GET']);
    });

    it('recognizes an absent document as legacy-compatible without creating a probe', async () => {
        const requests: string[] = [];
        const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init?.method ?? 'GET');
            return new Response(null, { status: 404 });
        }) as unknown as typeof fetch;

        await expect(probeWebdavSyncCompatibility(
            'https://example.com/dav/data.json',
            { fetcher },
        )).resolves.toBe('legacy-plaintext');
        expect(requests).toEqual(['GET']);
    });

    it('proves conditional writes when encryption requires strong ETags and data.json is absent', async () => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher, requests } = createWebdavCapabilityFetcher(documentUrl);

        await expect(probeWebdavSyncCompatibility(
            documentUrl,
            { fetcher },
            { requireStrongEtag: true },
        )).resolves.toBe('strong-etag');

        expect(requests.map(({ method }) => method)).toEqual([
            'GET', 'PUT', 'GET', 'PUT', 'PUT', 'GET', 'PUT', 'DELETE', 'GET', 'DELETE',
        ]);
    });

    it.each([
        ['missing', null],
        ['weak', 'W/"legacy-v1"'],
    ])('rejects an existing document with a %s ETag when encryption requires a strong version', async (_case, etag) => {
        const requests: string[] = [];
        const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init?.method ?? 'GET');
            return new Response('{"tasks":[]}', {
                status: 200,
                headers: etag ? { etag } : undefined,
            });
        }) as unknown as typeof fetch;

        await expect(probeWebdavSyncCompatibility(
            'https://example.com/dav/data.json',
            { fetcher },
            { requireStrongEtag: true },
        )).rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
        expect(requests).toEqual(['GET']);
    });

    it('does not downgrade a strong-ETag server that fails conditional-write enforcement', async () => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher } = createWebdavCapabilityFetcher(documentUrl, {
            documentBody: '{"tasks":[]}',
            ignoreStaleMatch: true,
        });

        await expect(probeWebdavSyncCompatibility(documentUrl, { fetcher }))
            .rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
    });

    it.each([
        ['empty', ''],
        ['whitespace-only', ' \n\t'],
        ['BOM plus whitespace', '\uFEFF \n\t'],
        ['BOM-prefixed JSON', '\uFEFF \n {"tasks":[]} \n'],
    ])('accepts an existing strong-ETag document with a %s body', async (_case, body) => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher } = createWebdavCapabilityFetcher(documentUrl, { documentBody: body });

        await expect(assertWebdavStrongEtagSupport(
            documentUrl,
            { fetcher },
        )).resolves.toBeUndefined();
    });

    it.each([
        ['create-only', { ignoreCreateOnly: true }],
        ['stale replacement', { ignoreStaleMatch: true }],
    ] as const)('rejects a server that ignores the %s condition', async (_case, behavior) => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher, requests } = createWebdavCapabilityFetcher(documentUrl, behavior);

        await expect(assertWebdavStrongEtagSupport(documentUrl, { fetcher }))
            .rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
        expect(requests.some(({ method }) => method === 'DELETE')).toBe(true);
    });

    it('rejects a server that ignores stale conditional deletes', async () => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher } = createWebdavCapabilityFetcher(documentUrl, { ignoreStaleDelete: true });

        await expect(assertWebdavStrongEtagSupport(documentUrl, { fetcher }))
            .rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
    });

    it('rejects a server that cannot conditionally delete the current probe generation', async () => {
        const documentUrl = 'https://example.com/dav/data.json';
        const { fetcher } = createWebdavCapabilityFetcher(documentUrl, { rejectCurrentDelete: true });

        await expect(assertWebdavStrongEtagSupport(documentUrl, { fetcher }))
            .rejects.toThrow('WebDAV DELETE failed (405)');
    });

    it('rejects a 200 HTML/login body even when that response has a strong ETag', async () => {
        const fetcher = vi.fn(async () => new Response('<html>Sign in</html>', {
            status: 200,
            headers: { etag: '"login-v1"' },
        })) as unknown as typeof fetch;

        await expect(assertWebdavStrongEtagSupport(
            'https://example.com/dav/data.json',
            { fetcher },
        )).rejects.toThrow('WebDAV GET failed: invalid JSON');
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([
        ['missing', null],
        ['weak', 'W/"v1"'],
    ])('rejects an existing document with a %s ETag before any write', async (_case, etag) => {
        const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), {
            status: 200,
            headers: etag ? { etag } : undefined,
        })) as unknown as typeof fetch;

        await expect(assertWebdavStrongEtagSupport(
            'https://example.com/dav/data.json',
            { fetcher },
        )).rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('does not issue an unguarded cleanup when the created probe rereads with a weak ETag', async () => {
        const methods: string[] = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            if (String(input).endsWith('/data.json')) return new Response(null, { status: 404 });
            if (method === 'PUT') return new Response(null, { status: 201 });
            if (method === 'GET') {
                return new Response(new Uint8Array([1]), {
                    status: 200,
                    headers: { etag: 'W/"probe-v1"' },
                });
            }
            throw new Error(`unexpected unsafe ${method}`);
        }) as unknown as typeof fetch;

        await expect(assertWebdavStrongEtagSupport(
            'https://example.com/dav/data.json',
            { fetcher },
        )).rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);
        expect(methods).toEqual(['GET', 'PUT', 'GET']);
    });
});

describe('error body cap', () => {
    it('does not paste an oversized error body into the thrown message', async () => {
        const huge = 'x'.repeat(MAX_ERROR_BODY_BYTES + 1);
        const fetcher = vi.fn(async () => makeResponse({
            ok: false,
            status: 500,
            statusText: 'Server Error',
            text: async () => huge,
        }));

        await expect(webdavGetJson('https://dav.example/data.json', { fetcher: fetcher as unknown as typeof fetch }))
            .rejects.toThrow(/WebDAV GET failed \(500\): Server Error/);
    });

    it('still includes a small error body', async () => {
        const fetcher = vi.fn(async () => makeResponse({
            ok: false,
            status: 500,
            statusText: 'Server Error',
            text: async () => 'quota exceeded',
        }));

        await expect(webdavGetJson('https://dav.example/data.json', { fetcher: fetcher as unknown as typeof fetch }))
            .rejects.toThrow(/quota exceeded/);
    });
});
