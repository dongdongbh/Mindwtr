import { describe, expect, it, vi } from 'vitest';
import { webdavGetJson, webdavPutFile, webdavPutJson } from './webdav';

const makeResponse = (overrides: Partial<Response> & { status: number; ok: boolean }): Response => ({
    statusText: '',
    text: async () => '',
    ...overrides,
}) as Response;

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

    it('rejects HTTP for public targets', async () => {
        const fetcher = vi.fn();
        await expect(webdavGetJson('http://8.8.8.8/dav/data.json', { fetcher })).rejects.toThrow(
            'WebDAV requires HTTPS for public URLs',
        );
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('allows explicit insecure HTTP overrides for public targets', async () => {
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
        ).resolves.toBeUndefined();

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
        ).resolves.toBeUndefined();

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
        ).resolves.toBeUndefined();

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
