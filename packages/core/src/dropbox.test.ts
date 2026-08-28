import { describe, expect, it, vi } from 'vitest';
import {
    deleteDropboxFileVersioned,
    downloadDropboxAppData,
    downloadDropboxFile,
    downloadDropboxFileVersioned,
    DropboxConflictError,
    DropboxUnauthorizedError,
    getDropboxFileMetadata,
    listDropboxFolderFiles,
    testDropboxAccess,
    uploadDropboxAppData,
    uploadDropboxFileVersioned,
} from './dropbox';
import { deriveSyncKeyMaterial } from './sync-crypto';
import type { AppData } from './types';

const FAST_KDF = { mKib: 8, t: 1, p: 1 };

/** Minimal in-memory fake of the two Dropbox endpoints these functions call, keyed by
 * `path` from the `Dropbox-API-Arg` header — enough to round-trip upload/download. */
function createFakeDropbox() {
    const files = new Map<string, Uint8Array>();
    const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const arg = JSON.parse((init?.headers as Record<string, string>)['Dropbox-API-Arg']) as { path: string };
        const target = String(url);
        if (target.includes('/download')) {
            const bytes = files.get(arg.path);
            if (!bytes) {
                return Response.json({
                    error_summary: 'path/not_found/...',
                    error: { '.tag': 'path', path: { '.tag': 'not_found' } },
                }, { status: 409 });
            }
            return {
                ok: true,
                status: 200,
                headers: { get: (name: string) => (name === 'dropbox-api-result' ? JSON.stringify({ rev: 'rev1' }) : null) } as unknown as Headers,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                text: async () => new TextDecoder().decode(bytes),
            } as Response;
        }
        // upload
        const bodyBytes = init!.body instanceof ArrayBuffer
            ? new Uint8Array(init!.body)
            : new TextEncoder().encode(init!.body as string);
        files.set(arg.path, bodyBytes);
        return {
            ok: true,
            status: 200,
            headers: { get: () => null } as unknown as Headers,
            json: async () => ({ rev: 'rev1' }),
            text: async () => '',
        } as Response;
    };
    return { files, fetcher };
}

describe('dropbox sync-document encryption', () => {
    it('aborts a bounded Dropbox request and reports a retryable timeout', async () => {
        let requestSignal: AbortSignal | undefined;
        const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            requestSignal = init?.signal ?? undefined;
            return new Promise((_resolve, reject) => {
                requestSignal?.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        };

        await expect(downloadDropboxFile('token', '/attachment', fetcher, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox file download timed out');
        expect(requestSignal?.aborted).toBe(true);
    });

    it('rejects a second plaintext or encrypted first-writer after both clients read an absent remote', async () => {
        const data: AppData = { tasks: [] } as unknown as AppData;
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(9), FAST_KDF);

        for (const crypto of [{}, { material }]) {
            let exists = false;
            const args: Array<{ path: string; mode: { '.tag': string }; autorename?: boolean; strict_conflict?: boolean }> = [];
            const fetcher = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
                const arg = JSON.parse(new Headers(init?.headers).get('dropbox-api-arg') ?? '{}') as typeof args[number];
                args.push(arg);
                if (exists && arg.mode['.tag'] === 'add') {
                    return Response.json({ error_summary: 'path/conflict/file/...' }, { status: 409 });
                }
                exists = true;
                return Response.json({ rev: `rev-${args.length}` });
            };

            await uploadDropboxAppData('token', data, null, fetcher, crypto);
            await expect(uploadDropboxAppData('token', data, null, fetcher, crypto))
                .rejects.toBeInstanceOf(DropboxConflictError);
            expect(args[0]).toEqual(expect.objectContaining({
                mode: { '.tag': 'add' },
                autorename: false,
                strict_conflict: true,
            }));
        }
    });

    it('encrypts on upload to the .enc path and decrypts on download, leaving the plain path untouched', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(1), FAST_KDF);
        const data: AppData = { tasks: [] } as unknown as AppData;

        await uploadDropboxAppData('token', data, null, fetcher, { material });
        expect(files.has('/data.json.enc')).toBe(true);
        expect(files.has('/data.json')).toBe(false);

        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toEqual(data);
    });

    it('off-state path is unchanged: plain JSON at /data.json, no encryption params needed', async () => {
        const { files, fetcher } = createFakeDropbox();
        const data: AppData = { tasks: [] } as unknown as AppData;
        await uploadDropboxAppData('token', data, null, fetcher);
        expect(files.has('/data.json')).toBe(true);
        expect(new TextDecoder().decode(files.get('/data.json')!)).toBe(JSON.stringify(data));
        const result = await downloadDropboxAppData('token', fetcher);
        expect(result.data).toEqual(data);
    });

    it('an off-state device discovers an encrypted-but-plaintext-deleted remote instead of treating it as empty', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(2), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher, { material });
        expect(files.has('/data.json')).toBe(false); // plain path genuinely gone

        const result = await downloadDropboxAppData('token', fetcher); // no material — this device is 'off'
        expect(result.data).toBeNull();
        expect(result.encryptedNoKey).toBeDefined();
        expect(result.encryptedNoKey!.salt.length).toBe(16);
    });

    // The other direction of the same one-extra-probe rule: a peer disabled encryption, so
    // `/data.json.enc` is gone and `/data.json` is back. "Empty remote" here would push this
    // device's whole store into a fresh generation and fork the two silently.
    it('an enabled device reports a peer-disabled (plaintext-restored) remote instead of treating it as empty', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(4), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher); // the peer's plaintext write
        expect(files.has('/data.json.enc')).toBe(false);

        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toBeNull();
        expect(result.remotePlaintext).toBe(true);
    });

    it('an enabled device still reports an empty remote when neither path exists', async () => {
        const { fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(5), FAST_KDF);
        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toBeNull();
        expect(result.remotePlaintext).toBeUndefined();
    });

    it.each([
        ['off', {}],
        ['keyed', { material: null }],
    ] as const)('a %s device requires explicit path/not_found before opposite-generation discovery', async (_posture, cryptoTemplate) => {
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(6), FAST_KDF);
        const crypto = cryptoTemplate.material === null ? { material } : {};
        const urls: string[] = [];
        let downloadCalls = 0;
        const fetcher = async (url: string | URL): Promise<Response> => {
            urls.push(String(url));
            if (String(url).includes('/upload')) return Response.json({ rev: 'unexpected-upload' });
            downloadCalls += 1;
            if (downloadCalls === 1) {
                return Response.json({
                    error_summary: 'path/conflict/file/...',
                    error: { '.tag': 'path', path: { '.tag': 'conflict' } },
                }, { status: 409 });
            }
            return Response.json({
                error_summary: 'path/not_found/...',
                error: { '.tag': 'path', path: { '.tag': 'not_found' } },
            }, { status: 409 });
        };
        const attempt = async () => {
            const remote = await downloadDropboxAppData('token', fetcher, crypto);
            await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, remote.rev, fetcher, crypto);
        };

        await expect(attempt()).rejects.toThrow(/Dropbox download failed: HTTP 409/);
        expect(downloadCalls).toBe(1);
        expect(urls.some((url) => url.includes('/upload'))).toBe(false);
    });

    it.each([
        ['off', {}],
        ['keyed', { material: null }],
    ] as const)('a %s device propagates an unreadable primary 409 body without probing or uploading', async (_posture, cryptoTemplate) => {
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(7), FAST_KDF);
        const crypto = cryptoTemplate.material === null ? { material } : {};
        const urls: string[] = [];
        const fetcher = async (url: string | URL): Promise<Response> => {
            urls.push(String(url));
            if (String(url).includes('/upload')) return Response.json({ rev: 'unexpected-upload' });
            return new Response('not-json', { status: 409 });
        };
        const attempt = async () => {
            const remote = await downloadDropboxAppData('token', fetcher, crypto);
            await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, remote.rev, fetcher, crypto);
        };

        await expect(attempt()).rejects.toThrow(/Dropbox download failed: HTTP 409/);
        expect(urls).toHaveLength(1);
        expect(urls.some((url) => url.includes('/upload'))).toBe(false);
    });

    it.each([
        ['off', 429, null, {}],
        ['off', 503, null, {}],
        ['off', 409, 'path/conflict', {}],
        ['off', 409, 'invalid-body', {}],
        ['keyed', 429, null, { material: null }],
        ['keyed', 503, null, { material: null }],
        ['keyed', 409, 'path/conflict', { material: null }],
        ['keyed', 409, 'invalid-body', { material: null }],
    ] as const)(
        'a %s device propagates opposite-generation HTTP %i (%s) and never uploads',
        async (_posture, probeStatus, probeTag, cryptoTemplate) => {
            const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(8), FAST_KDF);
            const crypto = cryptoTemplate.material === null ? { material } : {};
            const urls: string[] = [];
            let downloadCalls = 0;
            const fetcher = async (url: string | URL): Promise<Response> => {
                urls.push(String(url));
                if (String(url).includes('/upload')) return Response.json({ rev: 'unexpected-upload' });
                downloadCalls += 1;
                if (downloadCalls === 1) {
                    return Response.json({
                        error_summary: 'path/not_found/...',
                        error: { '.tag': 'path', path: { '.tag': 'not_found' } },
                    }, { status: 409 });
                }
                if (probeTag === 'path/conflict') {
                    return Response.json({
                        error_summary: 'path/conflict/file/...',
                        error: { '.tag': 'path', path: { '.tag': 'conflict' } },
                    }, { status: probeStatus });
                }
                if (probeTag === 'invalid-body') return new Response('not-json', { status: probeStatus });
                return new Response(null, { status: probeStatus });
            };
            const attempt = async () => {
                const remote = await downloadDropboxAppData('token', fetcher, crypto);
                await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, remote.rev, fetcher, crypto);
            };

            await expect(attempt()).rejects.toThrow(new RegExp(`Dropbox download failed: HTTP ${probeStatus}`));
            expect(downloadCalls).toBe(2);
            expect(urls.some((url) => url.includes('/upload'))).toBe(false);
        },
    );

    it('a wrong key fails closed on download instead of returning garbage', async () => {
        const { fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(3), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher, { material });
        const wrongMaterial = await deriveSyncKeyMaterial('other-pw', material.salt, FAST_KDF);
        await expect(downloadDropboxAppData('token', fetcher, { material: wrongMaterial })).rejects.toThrow();
    });
});

describe('bounded Dropbox folder inventory', () => {
    const hangingResponse = (signal: AbortSignal): Promise<Response> => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const hangingBodyResponse = (headers: Record<string, string> = {}, status = 200) => {
        const cancel = vi.fn();
        return {
            cancel,
            response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status, headers }),
        };
    };

    it('paginates through the bounded transport', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({
                entries: [{ '.tag': 'file', name: 'A.bin', path_lower: '/attachments/a.bin' }],
                cursor: 'next-page',
                has_more: true,
            }))
            .mockResolvedValueOnce(Response.json({
                entries: [{ '.tag': 'file', name: 'B.bin', path_lower: '/attachments/b.bin' }],
                cursor: 'done',
                has_more: false,
            }));

        await expect(listDropboxFolderFiles('token', '/attachments', fetcher)).resolves.toEqual([
            { name: 'A.bin', pathLower: '/attachments/a.bin' },
            { name: 'B.bin', pathLower: '/attachments/b.bin' },
        ]);
        expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ cursor: 'next-page' });
    });

    it('times out and aborts a hanging first page', async () => {
        let requestSignal: AbortSignal | undefined;
        const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined;
            return hangingResponse(requestSignal!);
        }) as typeof fetch;

        await expect(listDropboxFolderFiles('token', '/attachments', fetcher, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox folder inventory request timed out');
        expect(requestSignal?.aborted).toBe(true);
    });

    it('times out and aborts a hanging continuation page', async () => {
        let continuationSignal: AbortSignal | undefined;
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({ entries: [], cursor: 'next-page', has_more: true }))
            .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
                continuationSignal = init?.signal ?? undefined;
                return hangingResponse(continuationSignal!);
            }) as typeof fetch;

        await expect(listDropboxFolderFiles('token', '/attachments', fetcher, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox folder inventory request timed out');
        expect(continuationSignal?.aborted).toBe(true);
    });

    it('times out and cancels a first page whose body stalls after headers', async () => {
        const { cancel, response } = hangingBodyResponse();

        await expect(listDropboxFolderFiles('token', '/attachments', async () => response, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox folder inventory request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('times out and cancels a stalled Dropbox error body used for path classification', async () => {
        const { cancel, response } = hangingBodyResponse({}, 409);

        await expect(listDropboxFolderFiles('token', '/attachments', async () => response, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox folder inventory request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('times out and cancels a continuation body that stalls after headers', async () => {
        const { cancel, response } = hangingBodyResponse();
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({ entries: [], cursor: 'next-page', has_more: true }))
            .mockResolvedValueOnce(response) as typeof fetch;

        await expect(listDropboxFolderFiles('token', '/attachments', fetcher, { timeoutMs: 1 }))
            .rejects.toThrow('Dropbox folder inventory request timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('classifies authorization failures for a caller refresh retry', async () => {
        await expect(listDropboxFolderFiles('token', '/attachments', async () => (
            new Response(null, { status: 401 })
        ))).rejects.toBeInstanceOf(DropboxUnauthorizedError);
    });
});

describe('versioned Dropbox transition byte operations', () => {
    it('classifies only exact path absence as a missing attachment generation', async () => {
        const existing = await getDropboxFileMetadata('token', '/attachments/a.bin', async () => (
            Response.json({ rev: 'abc123456' })
        ));
        const missing = await getDropboxFileMetadata('token', '/attachments/missing.bin', async () => (
            Response.json({
                error_summary: 'path/not_found/...',
                error: { '.tag': 'path', path: { '.tag': 'not_found' } },
            }, { status: 409 })
        ));

        expect(existing).toEqual({ rev: 'abc123456' });
        expect(missing).toEqual({ rev: null });
        await expect(getDropboxFileMetadata('token', '/attachments/a.bin', async () => (
            Response.json({
                error_summary: 'path/conflict/file/...',
                error: { '.tag': 'path', path: { '.tag': 'conflict' } },
            }, { status: 409 })
        ))).rejects.toThrow('Dropbox file metadata failed: HTTP 409');
    });

    it('returns bytes and revision from the same download response', async () => {
        const result = await downloadDropboxFileVersioned('token', '/attachments/a.bin', async () => (
            new Response(new Uint8Array([1, 2]), {
                status: 200,
                headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'abc123456' }) },
            })
        ));
        expect(result).toEqual({ bytes: new Uint8Array([1, 2]), version: 'abc123456' });
    });

    it('times out a versioned download whose body stalls after headers', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 200,
            headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'abc123456' }) },
        });

        await expect(downloadDropboxFileVersioned(
            'token',
            '/attachments/a.bin',
            async () => response,
            { timeoutMs: 1 },
        )).rejects.toThrow('Dropbox versioned file download timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('uses add for create and update(rev) for replacement', async () => {
        const args: unknown[] = [];
        const fetcher = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
            args.push(JSON.parse(new Headers(init?.headers).get('dropbox-api-arg') ?? '{}'));
            return Response.json({ rev: 'next-rev' });
        };
        await uploadDropboxFileVersioned('token', '/a.bin', new Uint8Array([1]), null, fetcher);
        await uploadDropboxFileVersioned('token', '/a.bin', new Uint8Array([2]), 'old-rev', fetcher);
        expect(args).toEqual([
            expect.objectContaining({ mode: { '.tag': 'add' }, autorename: false, strict_conflict: true }),
            expect.objectContaining({ mode: { '.tag': 'update', update: 'old-rev' }, autorename: false, strict_conflict: true }),
        ]);
    });

    it('times out an upload whose revision body stalls after the mutation response headers', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });

        await expect(uploadDropboxFileVersioned(
            'token',
            '/a.bin',
            new Uint8Array([1]),
            null,
            async () => response,
            { timeoutMs: 1 },
        )).rejects.toThrow('Dropbox versioned file upload timed out');
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('sends parent_rev on delete and maps stale revisions to conflict', async () => {
        let body: unknown;
        const fetcher = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
            body = JSON.parse(String(init?.body));
            return new Response(null, { status: 409 });
        };
        await expect(deleteDropboxFileVersioned('token', '/a.bin', 'old-rev', fetcher))
            .rejects.toBeInstanceOf(DropboxConflictError);
        expect(body).toEqual({ path: '/a.bin', parent_rev: 'old-rev' });
    });

    it.each([
        ['successful delete', (fetcher: typeof fetch) => deleteDropboxFileVersioned(
            'token', '/a.bin', 'old-rev', fetcher, { timeoutMs: 1 },
        ), 200],
        ['missing connection probe', (fetcher: typeof fetch) => testDropboxAccess(
            'token', fetcher, { timeoutMs: 1 },
        ), 409],
    ])('times out and cancels a stalled %s response body', async (_kind, request, status) => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status });

        await expect(request(async () => response)).rejects.toThrow(/timed out/i);
        expect(cancel).toHaveBeenCalledOnce();
    }, 100);

    it('cancels an unread 401 body before surfacing the Dropbox error', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 });

        await expect(deleteDropboxFileVersioned(
            'token', '/a.bin', 'old-rev', async () => response,
        )).rejects.toBeInstanceOf(DropboxUnauthorizedError);
        expect(cancel).toHaveBeenCalledOnce();
    });
});
