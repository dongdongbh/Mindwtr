import { describe, expect, it, vi } from 'vitest';
import {
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
    webdavMutationFenceUrl,
} from './sync-remote-fence-providers';

const SERVER_DATE = 'Tue, 27 Aug 2026 12:00:00 GMT';

describe('remote mutation fence provider ports', () => {
    it('uses a sibling WebDAV artifact and preserves exact CAS conditions', async () => {
        const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'GET') {
                return new Response(new Uint8Array([1]), {
                    status: 200,
                    headers: { date: SERVER_DATE, etag: '"f1"' },
                });
            }
            return new Response(null, { status: method === 'DELETE' ? 204 : 200, headers: { date: SERVER_DATE } });
        }) as unknown as typeof fetch;
        const port = createWebdavSyncRemoteMutationFencePort(
            'https://dav.example/root/data.json?ignored=1',
            { fetcher },
        );

        expect(webdavMutationFenceUrl('https://dav.example/root/data.json?ignored=1'))
            .toBe('https://dav.example/root/.mindwtr-sync-fence-v1.json');
        await expect(port.read()).resolves.toEqual({
            bytes: new Uint8Array([1]),
            version: '"f1"',
            serverNowMs: Date.parse(SERVER_DATE),
        });
        await port.write(new Uint8Array([2]), '"f1"');
        await port.remove('"f1"');

        expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('if-match')).toBe('"f1"');
        expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('if-match')).toBe('"f1"');
    });

    it('uses Dropbox add/update/delete revisions and exposes provider time', async () => {
        const calls: Array<{ url: string; arg: Record<string, unknown>; body: unknown }> = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            const arg = JSON.parse(headers.get('dropbox-api-arg') ?? '{}') as Record<string, unknown>;
            calls.push({ url, arg, body: init?.body });
            if (url.endsWith('/download')) {
                return new Response(new Uint8Array([7]), {
                    status: 200,
                    headers: {
                        date: SERVER_DATE,
                        'Dropbox-API-Result': JSON.stringify({ rev: 'r1' }),
                    },
                });
            }
            if (url.endsWith('/upload')) return Response.json({ rev: 'r2' });
            return Response.json({});
        }) as unknown as typeof fetch;
        const port = createDropboxSyncRemoteMutationFencePort('token', fetcher);

        await expect(port.read()).resolves.toEqual({
            bytes: new Uint8Array([7]),
            version: 'r1',
            serverNowMs: Date.parse(SERVER_DATE),
        });
        await port.write(new Uint8Array([8]), null);
        await port.write(new Uint8Array([9]), 'r2');
        await port.remove('r2');

        expect(calls[0]?.arg).toEqual({ path: '/.mindwtr-sync-fence-v1.json' });
        expect(calls[1]?.arg).toMatchObject({ mode: { '.tag': 'add' }, autorename: false });
        expect(calls[2]?.arg).toMatchObject({ mode: { '.tag': 'update', update: 'r2' } });
        expect(JSON.parse(String(calls[3]?.body))).toEqual({
            path: '/.mindwtr-sync-fence-v1.json',
            parent_rev: 'r2',
        });
    });
});
