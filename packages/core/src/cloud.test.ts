import { describe, expect, it, vi } from 'vitest';
import {
    CLOUD_SYNC_TOKEN_PATTERN,
    CloudHttpError,
    cloudDeleteFile,
    cloudGetFile,
    cloudGetJson,
    cloudHeadJson,
    cloudPutFile,
    cloudPutJson,
    cloudRequestJson,
    buildCloudCalendarFeedUrl,
    getCloudCalendarFeedEndpoint,
    isValidCloudSyncToken,
} from './cloud';
import { MAX_DOWNLOAD_BYTES, ResponseTooLargeError } from './http-utils';

const okResponse = (text: string) =>
    ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
            get: () => null,
        },
        text: async () => text,
    }) as unknown as Response;

const headResponse = (headers: Record<string, string>) =>
    ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
            get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
        text: async () => '',
    }) as unknown as Response;

const errorResponse = (status: number, statusText: string) =>
    ({
        ok: false,
        status,
        statusText,
        text: async () => '',
    }) as unknown as Response;

const hangingBodyResponse = () => {
    const cancel = vi.fn();
    return {
        cancel,
        response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }),
    };
};

describe('cloud sync http helpers', () => {
    it('times out and cancels a JSON body that stalls after response headers', async () => {
        const { cancel, response } = hangingBodyResponse();

        await expect(cloudGetJson('https://example.com/v1/data', {
            fetcher: async () => response,
            timeoutMs: 1,
        })).rejects.toThrow('Cloud request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('times out and cancels a request JSON response body that stalls after headers', async () => {
        const { cancel, response } = hangingBodyResponse();

        await expect(cloudRequestJson('POST', 'https://example.com/v1/tasks', {}, {
            fetcher: async () => response,
            timeoutMs: 1,
        })).rejects.toThrow('Cloud request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('times out and cancels a post-write JSON body that stalls after mutation headers', async () => {
        const { cancel, response } = hangingBodyResponse();

        await expect(cloudPutJson('https://example.com/v1/data', { tasks: [] }, {
            fetcher: async () => response,
            timeoutMs: 1,
        })).rejects.toThrow('Cloud request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('returns null on 404 when fetching json', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        const result = await cloudGetJson('https://example.com/v1/data', { fetcher });
        expect(result).toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('parses json payload', async () => {
        const fetcher = vi.fn(async () => okResponse(JSON.stringify({ ok: true })));
        const result = await cloudGetJson<{ ok: boolean }>('https://example.com/v1/data', { fetcher });
        expect(result).toEqual({ ok: true });
    });

    it('throws on invalid json', async () => {
        const fetcher = vi.fn(async () => okResponse('not-json'));
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.toThrow(
            'invalid JSON',
        );
    });

    it('explains HTML responses from the wrong self-hosted endpoint', async () => {
        const fetcher = vi.fn(async () => okResponse('<!doctype html><html></html>'));
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.toThrow(
            'server returned HTML instead of Mindwtr sync data — check the Self-Hosted URL, host, and port',
        );
    });

    it('allows local HTTP targets without manual override', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        await expect(cloudGetJson('http://192.168.1.50:8787/v1/data', { fetcher })).resolves.toBeNull();
    });

    it('blocks public HTTP targets unless manually overridden', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        await expect(cloudGetJson('http://example.com/v1/data', { fetcher })).rejects.toThrow(
            'Cloud sync requires HTTPS for public URLs',
        );
        expect(fetcher).not.toHaveBeenCalled();
        await expect(cloudGetJson('http://example.com/v1/data', {
            fetcher,
            allowInsecureHttp: true,
        })).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('sends auth, method, and body on request json', async () => {
        const fetcher = vi.fn(async () => okResponse(JSON.stringify({ task: { id: 't1' } })));
        const result = await cloudRequestJson<{ task: { id: string } }>(
            'POST',
            'https://example.com/v1/tasks',
            { title: 'hi' },
            { fetcher, token: 'abc123' },
        );
        expect(result).toEqual({ task: { id: 't1' } });
        const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({ title: 'hi' });
    });

    it('parses a successful response body larger than the error-message cap', async () => {
        const bigDescription = 'x'.repeat(150 * 1024);
        const fetcher = vi.fn(async () => okResponse(JSON.stringify({ task: { id: 't1', description: bigDescription } })));
        const result = await cloudRequestJson<{ task: { id: string; description: string } }>(
            'POST',
            'https://example.com/v1/tasks',
            { title: 'hi' },
            { fetcher, token: 'abc123' },
        );
        expect(result?.task.id).toBe('t1');
        expect(result?.task.description).toHaveLength(150 * 1024);
    });

    it('omits body and content type on request json without a body', async () => {
        const fetcher = vi.fn(async () => okResponse(JSON.stringify({ ok: true })));
        await cloudRequestJson('DELETE', 'https://example.com/v1/tasks/t1', undefined, { fetcher });
        const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
        expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('surfaces server error messages with status on request json failures', async () => {
        const fetcher = vi.fn(async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => JSON.stringify({ error: 'Task not found' }),
        } as unknown as Response));
        const failure = cloudRequestJson('PATCH', 'https://example.com/v1/tasks/missing', { title: 'x' }, { fetcher });
        await expect(failure).rejects.toThrow('Task not found');
        await expect(failure).rejects.toBeInstanceOf(CloudHttpError);
        await expect(failure).rejects.toMatchObject({ status: 404 });
    });

    it('falls back to the status line when the error body is not json', async () => {
        const fetcher = vi.fn(async () => errorResponse(500, 'Internal Server Error'));
        await expect(
            cloudRequestJson('POST', 'https://example.com/v1/tasks', {}, { fetcher }),
        ).rejects.toThrow('Cloud POST failed (500): Internal Server Error');
    });

    it('appends a wrong-server hint on 405 for cloud GET', async () => {
        const fetcher = vi.fn(async () => errorResponse(405, 'Method Not Allowed'));
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.toThrow(
            'Cloud GET failed (405): Method Not Allowed — this URL may not be a Mindwtr sync server (check host and port)',
        );
    });

    it('appends a wrong-server hint on 405 for cloud PUT', async () => {
        const fetcher = vi.fn(async () => errorResponse(405, 'Method Not Allowed'));
        await expect(
            cloudPutJson('https://example.com/v1/data', { hello: 'world' }, { fetcher }),
        ).rejects.toThrow(
            'Cloud PUT failed (405): Method Not Allowed — this URL may not be a Mindwtr sync server (check host and port)',
        );
    });

    it('does not append the wrong-server hint for non-405 statuses', async () => {
        const fetcher = vi.fn(async () => errorResponse(500, 'Internal Server Error'));
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.toThrow(
            'Cloud GET failed (500): Internal Server Error',
        );
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.not.toThrow(
            /may not be a Mindwtr sync server/,
        );
    });

    it('enforces the https policy on request json', async () => {
        const fetcher = vi.fn(async () => okResponse('{}'));
        await expect(
            cloudRequestJson('POST', 'http://example.com/v1/tasks', {}, { fetcher }),
        ).rejects.toThrow('Cloud sync requires HTTPS for public URLs');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('sends auth and content type on put json', async () => {
        const fetcher = vi.fn(async () => okResponse(''));
        await cloudPutJson('https://example.com/v1/data', { hello: 'world' }, { fetcher, token: 'abc123' });
        const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('PUT');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('returns post-write metadata from put json responses', async () => {
        const fetcher = vi.fn(async () => headResponse({
            etag: '"sha256-abc"',
            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
            'content-length': '42',
        }));

        const metadata = await cloudPutJson('https://example.com/v1/data', { hello: 'world' }, { fetcher });

        expect(metadata).toMatchObject({
            exists: true,
            fingerprint: 'cloud:v1:etag="sha256-abc"',
            etag: '"sha256-abc"',
        });
    });

    it('prefers server-returned post-merge fingerprint metadata', async () => {
        const fetcher = vi.fn(async () => ({
            ...headResponse({
                etag: '"response-body"',
                'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
            }),
            text: async () => JSON.stringify({
                remoteFingerprint: 'cloud:v1:etag="stored"',
                etag: '"stored"',
                contentLength: '123',
                serverMergedRemoteData: true,
            }),
        } as unknown as Response));

        const metadata = await cloudPutJson('https://example.com/v1/data', { hello: 'world' }, { fetcher });

        expect(metadata).toMatchObject({
            fingerprint: 'cloud:v1:etag="stored"',
            etag: '"stored"',
            contentLength: '123',
            serverMergedRemoteData: true,
        });
    });

    it('reads HEAD metadata for fast sync checks', async () => {
        const fetcher = vi.fn(async () => headResponse({
            etag: '"sha256-abc"',
            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
            'content-length': '42',
        }));

        const metadata = await cloudHeadJson('https://example.com/v1/data', { fetcher, token: 'abc123' });

        expect(metadata).toMatchObject({
            exists: true,
            fingerprint: 'cloud:v1:etag="sha256-abc"',
            etag: '"sha256-abc"',
        });
        const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('HEAD');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
    });

    it('treats 404 delete as success', async () => {
        const fetcher = vi.fn(async () => errorResponse(404, 'Not Found'));
        await expect(cloudDeleteFile('https://example.com/v1/file', { fetcher })).resolves.toBeUndefined();
    });

    it.each([
        ['PUT', (fetcher: typeof fetch) => cloudPutFile(
            'https://example.com/v1/file', new Uint8Array([1]), 'application/octet-stream',
            { fetcher, timeoutMs: 1 },
        )],
        ['DELETE 404', (fetcher: typeof fetch) => cloudDeleteFile(
            'https://example.com/v1/file', { fetcher, timeoutMs: 1 },
        )],
    ])('times out and cancels a stalled successful %s response body', async (kind, request) => {
        const cancel = vi.fn();
        const status = kind === 'DELETE 404' ? 404 : 200;
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status });

        await expect(request(async () => response)).rejects.toThrow('Cloud request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('exposes status on file get failures', async () => {
        const fetcher = vi.fn(async () => errorResponse(404, 'Not Found'));

        await expect(cloudGetFile('https://example.com/v1/file', { fetcher })).rejects.toMatchObject({
            message: 'Cloud File GET failed (404): Not Found',
            status: 404,
            statusCode: 404,
        });
    });

    it('throws on delete failures', async () => {
        const fetcher = vi.fn(async () => errorResponse(500, 'Server Error'));
        await expect(cloudDeleteFile('https://example.com/v1/file', { fetcher })).rejects.toThrow(
            'Cloud DELETE failed (500)',
        );
    });
});

describe('isValidCloudSyncToken', () => {
    it('rejects tokens shorter than 20 characters', () => {
        expect(isValidCloudSyncToken('short-token')).toBe(false);
    });

    it('accepts a 20-character token', () => {
        expect(isValidCloudSyncToken('a'.repeat(20))).toBe(true);
    });

    it('accepts a 512-character token', () => {
        expect(isValidCloudSyncToken('a'.repeat(512))).toBe(true);
    });

    it('rejects a 513-character token', () => {
        expect(isValidCloudSyncToken('a'.repeat(513))).toBe(false);
    });

    it('rejects disallowed characters', () => {
        expect(isValidCloudSyncToken(`${'a'.repeat(19)}!`)).toBe(false);
        expect(isValidCloudSyncToken(`${'a'.repeat(9)} ${'a'.repeat(10)}`)).toBe(false);
    });

    it('trims surrounding whitespace before testing', () => {
        expect(isValidCloudSyncToken(`  ${'a'.repeat(20)}  `)).toBe(true);
    });

    it('matches the exported pattern directly', () => {
        expect(CLOUD_SYNC_TOKEN_PATTERN.test('a'.repeat(20))).toBe(true);
        expect(CLOUD_SYNC_TOKEN_PATTERN.test('a'.repeat(19))).toBe(false);
    });
});

describe('calendar feed URLs', () => {
    it('derives the feed endpoints from whatever sync URL shape the user saved', () => {
        for (const saved of [
            'https://example.com',
            'https://example.com/',
            'https://example.com/v1',
            'https://example.com/v1/data',
        ]) {
            expect(getCloudCalendarFeedEndpoint(saved)).toBe('https://example.com/v1/calendar/feed');
            expect(buildCloudCalendarFeedUrl(saved, 'abc')).toBe('https://example.com/v1/calendar/abc.ics');
        }
    });

    it('keeps a reverse-proxy path prefix', () => {
        expect(buildCloudCalendarFeedUrl('https://example.com/mindwtr/v1/data', 'abc'))
            .toBe('https://example.com/mindwtr/v1/calendar/abc.ics');
    });
});

describe('cloudGetFile download cap', () => {
    const fileResponse = (chunks: Uint8Array[], headers: Record<string, string>) => {
        const read = vi.fn(async () => {
            const value = chunks.shift();
            return value ? { done: false, value } : { done: true, value: undefined };
        });
        const res = {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            body: { getReader: () => ({ read, cancel: async () => {} }) },
            arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
        } as unknown as Response;
        return { res, read };
    };

    it('rejects a hostile content-length without reading the body', async () => {
        const { res, read } = fileResponse([new Uint8Array([1])], {
            'content-length': String(MAX_DOWNLOAD_BYTES + 1),
        });
        await expect(
            cloudGetFile('https://example.com/v1/files/a', { fetcher: async () => res }),
        ).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(read).not.toHaveBeenCalled();
    });

    it('still streams a normal download and reports progress', async () => {
        const { res } = fileResponse([new Uint8Array([9, 9]), new Uint8Array([9])], {
            'content-length': '3',
        });
        const onProgress = vi.fn();
        const buffer = await cloudGetFile('https://example.com/v1/files/a', {
            fetcher: async () => res,
            onProgress,
        });
        expect(Array.from(new Uint8Array(buffer))).toEqual([9, 9, 9]);
        expect(onProgress.mock.calls).toEqual([[2, 3], [3, 3]]);
    });

    it('times out and cancels a file body that stalls after response headers', async () => {
        const { cancel, response } = hangingBodyResponse();

        await expect(cloudGetFile('https://example.com/v1/files/a', {
            fetcher: async () => response,
            timeoutMs: 1,
        })).rejects.toThrow('Cloud request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);
});
