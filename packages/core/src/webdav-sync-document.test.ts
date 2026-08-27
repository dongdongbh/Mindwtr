import { describe, expect, it, vi } from 'vitest';
import {
    getWebdavDocumentVersionFromError,
    webdavGetSyncDocument,
    webdavPutSyncDocument,
} from './webdav';
import { deriveSyncKeyMaterial } from './sync-crypto';

const FAST_KDF = { mKib: 8, t: 1, p: 1 };

/** Minimal in-memory fake WebDAV server: GET/PUT keyed by URL, byte-accurate. */
function createFakeWebdavServer() {
    const files = new Map<string, Uint8Array>();
    const versions = new Map<string, number>();
    const requests: { url: string; method: string; headers: Headers }[] = [];
    const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const key = String(url);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        requests.push({ url: key, method, headers });
        if (method === 'GET') {
            const bytes = files.get(key);
            if (!bytes) {
                return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null } as unknown as Headers, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) } as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ etag: `"v${versions.get(key) ?? 1}"` }),
                text: async () => new TextDecoder().decode(bytes),
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            } as Response;
        }
        if (method === 'PUT') {
            const current = files.get(key);
            const currentEtag = current ? `"v${versions.get(key) ?? 1}"` : null;
            if (headers.get('if-none-match') === '*' && current) {
                return new Response(null, { status: 412 });
            }
            if (headers.has('if-match') && headers.get('if-match') !== currentEtag) {
                return new Response(null, { status: 412 });
            }
            const bodyBytes = init!.body instanceof ArrayBuffer
                ? new Uint8Array(init!.body)
                : init!.body instanceof Uint8Array
                    ? init!.body
                    : new TextEncoder().encode(init!.body as string);
            files.set(key, bodyBytes);
            const version = (versions.get(key) ?? 0) + 1;
            versions.set(key, version);
            return new Response(null, { status: current ? 204 : 201, headers: { etag: `"v${version}"` } });
        }
        throw new Error(`unsupported method ${method} in fake webdav server`);
    };
    return { files, fetcher, requests };
}

const URL_ = 'https://example.com/dav/data.json';

describe('webdav sync-document encryption', () => {
    it('encrypts on PUT to the .enc url and decrypts on GET, leaving the plain url untouched', async () => {
        const { files, fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(1), FAST_KDF);
        const data = { tasks: [] };

        await webdavPutSyncDocument(URL_, data, { fetcher, material, expectedEtag: null });
        expect(files.has(`${URL_}.enc`)).toBe(true);
        expect(files.has(URL_)).toBe(false);

        const result = await webdavGetSyncDocument<typeof data>(URL_, { fetcher, material });
        expect(result).toEqual({ state: 'data', data, exists: true, strongEtag: '"v1"' });
    });

    it('off-state path is unchanged: plain JSON at the plain url with no material', async () => {
        const { files, fetcher } = createFakeWebdavServer();
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher, expectedEtag: null });
        expect(files.has(URL_)).toBe(true);
        expect(new TextDecoder().decode(files.get(URL_)!)).toBe(JSON.stringify(data, null, 2));
        const result = await webdavGetSyncDocument<typeof data>(URL_, { fetcher });
        expect(result).toEqual({ state: 'data', data, exists: true, strongEtag: '"v1"' });
    });

    it('an off-state device discovers an encrypted-but-plaintext-deleted remote instead of treating it as empty', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(2), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material, expectedEtag: null });

        const result = await webdavGetSyncDocument(URL_, { fetcher }); // no material — this device is 'off'
        expect(result.state).toBe('encrypted-no-key');
        if (result.state === 'encrypted-no-key') {
            expect(result.salt.length).toBe(16);
        }
    });

    it('a wrong key fails closed on GET instead of returning garbage', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(3), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material, expectedEtag: null });
        const wrongMaterial = await deriveSyncKeyMaterial('other-pw', material.salt, FAST_KDF);
        await expect(webdavGetSyncDocument(URL_, { fetcher, material: wrongMaterial })).rejects.toThrow();
    });

    // A passphrase set before the first sync while a peer encrypted the remote, or a peer's
    // rotation: the key is for a DIFFERENT salt than the remote's artifacts. That is a
    // provable generation mismatch, reported as encrypted-no-key (which the caller persists
    // and the unlock prompt heals by re-deriving from the remote's salt) — never a dead-end
    // Auth failure, and never "no data" (which would fork the remote's generation).
    it('a key under a foreign salt reports encrypted-no-key with the remote header salt', async () => {
        const { fetcher } = createFakeWebdavServer();
        const remoteMaterial = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(6), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material: remoteMaterial, expectedEtag: null });

        const foreignMaterial = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(7), FAST_KDF);
        const result = await webdavGetSyncDocument(URL_, { fetcher, material: foreignMaterial });
        expect(result.state).toBe('encrypted-no-key');
        if (result.state === 'encrypted-no-key') {
            expect(Array.from(result.salt)).toEqual(Array.from(remoteMaterial.salt));
        }
    });

    it('a genuinely missing remote (no .enc, no plain) reports state data/null, not encrypted-no-key', async () => {
        const { fetcher } = createFakeWebdavServer();
        const result = await webdavGetSyncDocument(URL_, { fetcher });
        expect(result).toEqual({ state: 'data', data: null, exists: false, strongEtag: null });
    });

    // Mirror of the off-state discovery above, in the other direction: a peer DISABLED
    // encryption at the sync location, so the `.enc` artifact is gone and a plaintext
    // document is back. Reporting "empty" here would merge this device's whole store into a
    // fresh remote generation and fork the two silently.
    it('an enabled device treats a peer-disabled (plaintext-restored) remote as terminal, not as empty', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(4), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, expectedEtag: null }); // the peer's plaintext write

        const result = await webdavGetSyncDocument(URL_, { fetcher, material });
        expect(result.state).toBe('remote-plaintext');
    });

    it('an enabled device still reports an empty remote when neither artifact exists', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(5), FAST_KDF);
        expect(await webdavGetSyncDocument(URL_, { fetcher, material })).toEqual({
            state: 'data', data: null, exists: false, strongEtag: null,
        });
    });

    it.each([401, 500])(
        'propagates a %s fallback error when an enabled device cannot inspect the plaintext generation',
        async (status) => {
            const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(5), FAST_KDF);
            const requests: { method: string; url: string }[] = [];
            const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const method = init?.method ?? 'GET';
                const url = String(input);
                requests.push({ method, url });
                if (method !== 'GET') throw new Error('fallback failure must not write');
                if (url === `${URL_}.enc`) return new Response(null, { status: 404 });
                return new Response('fallback failed', { status });
            }) as unknown as typeof fetch;

            await expect(webdavGetSyncDocument(URL_, { fetcher, material }))
                .rejects.toThrow(`WebDAV GET failed (${status})`);
            expect(requests).toEqual([
                { method: 'GET', url: `${URL_}.enc` },
                { method: 'GET', url: URL_ },
            ]);
        },
    );

    it.each([401, 500])(
        'propagates a %s fallback error when an off device cannot inspect the encrypted generation',
        async (status) => {
            const requests: { method: string; url: string }[] = [];
            const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const method = init?.method ?? 'GET';
                const url = String(input);
                requests.push({ method, url });
                if (method !== 'GET') throw new Error('fallback failure must not write');
                if (url === URL_) return new Response(null, { status: 404 });
                return new Response('fallback failed', { status });
            }) as unknown as typeof fetch;

            await expect(webdavGetSyncDocument(URL_, { fetcher }))
                .rejects.toThrow(`WebDAV GET failed (${status})`);
            expect(requests).toEqual([
                { method: 'GET', url: URL_ },
                { method: 'GET', url: `${URL_}.enc` },
            ]);
        },
    );

    it('treats nonempty plaintext under the encrypted fallback name as terminal', async () => {
        const { files, fetcher, requests } = createFakeWebdavServer();
        files.set(`${URL_}.enc`, new TextEncoder().encode('{"tasks":[]}'));

        await expect(webdavGetSyncDocument(URL_, { fetcher })).rejects.toMatchObject({
            name: 'SyncEncryptionTerminalError',
        });
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('treats ciphertext under the plaintext fallback name as terminal for a keyed device', async () => {
        const { files, fetcher, requests } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(10), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material, expectedEtag: null });
        files.set(URL_, files.get(`${URL_}.enc`)!);
        files.delete(`${URL_}.enc`);
        requests.length = 0;

        await expect(webdavGetSyncDocument(URL_, { fetcher, material })).rejects.toMatchObject({
            name: 'SyncEncryptionTerminalError',
        });
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('treats an unsupported MWENC1 body at the primary plaintext name as terminal', async () => {
        const { files, fetcher, requests } = createFakeWebdavServer();
        files.set(URL_, new TextEncoder().encode('MWENC1\u007ftruncated'));

        await expect(webdavGetSyncDocument(URL_, { fetcher })).rejects.toMatchObject({
            name: 'SyncEncryptionTerminalError',
        });
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('uses create-only then exact replacement validators on the plaintext path', async () => {
        const { fetcher, requests } = createFakeWebdavServer();
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, expectedEtag: null });
        const read = await webdavGetSyncDocument<{ tasks: unknown[] }>(URL_, { fetcher });
        await webdavPutSyncDocument(URL_, { tasks: [{ id: 'next' }] }, {
            fetcher,
            expectedEtag: read.strongEtag,
        });

        const puts = requests.filter((request) => request.method === 'PUT');
        expect(puts[0].headers.get('if-none-match')).toBe('*');
        expect(puts[0].headers.get('if-match')).toBeNull();
        expect(puts[1].headers.get('if-match')).toBe('"v1"');
        expect(puts[1].headers.get('if-none-match')).toBeNull();
    });

    it('uses the encrypted artifact ETag and rejects a stale replacement', async () => {
        const { fetcher, requests } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(8), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material, expectedEtag: null });
        const read = await webdavGetSyncDocument<{ tasks: unknown[] }>(URL_, { fetcher, material });
        await webdavPutSyncDocument(URL_, { tasks: [{ id: 'next' }] }, {
            fetcher, material, expectedEtag: read.strongEtag,
        });

        const encryptedPuts = requests.filter((request) => request.method === 'PUT' && request.url.endsWith('.enc'));
        expect(encryptedPuts[1].headers.get('if-match')).toBe('"v1"');
        await expect(webdavPutSyncDocument(URL_, { tasks: [{ id: 'stale' }] }, {
            fetcher, material, expectedEtag: read.strongEtag,
        })).rejects.toThrow('WEBDAV_REMOTE_WRITE_CONFLICT');
    });

    it('preserves the create condition across MKCOL recovery retry', async () => {
        const putHeaders: Headers[] = [];
        let putCount = 0;
        const fetcher = (async (_url: string | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'PUT') {
                putHeaders.push(new Headers(init?.headers));
                putCount += 1;
                return new Response(null, { status: putCount === 1 ? 409 : 201, headers: { etag: '"created"' } });
            }
            if (method === 'MKCOL') return new Response(null, { status: 201 });
            throw new Error(`unexpected ${method}`);
        }) as typeof fetch;

        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, expectedEtag: null });

        expect(putHeaders).toHaveLength(2);
        expect(putHeaders.every((headers) => headers.get('if-none-match') === '*')).toBe(true);
    });

    it('maps a final conditional 409 after MKCOL recovery to a write conflict', async () => {
        const fetcher = (async (_url: string | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'PUT') return new Response(null, { status: 409 });
            if (method === 'MKCOL') return new Response(null, { status: 201 });
            throw new Error(`unexpected ${method}`);
        }) as typeof fetch;

        await expect(webdavPutSyncDocument(URL_, { tasks: [] }, {
            fetcher,
            expectedEtag: null,
        })).rejects.toThrow('WEBDAV_REMOTE_WRITE_CONFLICT');
    });

    it('rejects weak GET ETags as replacement validators', async () => {
        const { fetcher: baseFetcher } = createFakeWebdavServer();
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher: baseFetcher, expectedEtag: null });
        const fetcher = (async (url: string | URL, init?: RequestInit) => {
            const response = await baseFetcher(url, init);
            if ((init?.method ?? 'GET') !== 'GET' || !response.ok) return response;
            return { ...response, headers: new Headers({ etag: 'W/"v1"' }) } as Response;
        }) as typeof fetch;

        const result = await webdavGetSyncDocument(URL_, { fetcher });
        expect(result).toMatchObject({ state: 'data', exists: true, strongEtag: null });
    });

    it('carries the GET validator on an invalid-JSON error for conditional repair', async () => {
        const fetcher = (async () => new Response('{broken', {
            status: 200,
            headers: { etag: '"broken-v3"' },
        })) as typeof fetch;

        const error = await webdavGetSyncDocument(URL_, { fetcher }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(getWebdavDocumentVersionFromError(error)).toEqual({
            exists: true,
            strongEtag: '"broken-v3"',
        });
    });
});

describe('sync-document download cap', () => {
    /** Wraps a fake server so GETs report `declaredLength` in content-length. The cap
     *  rejects on that header before reading, so a huge library is simulated by the
     *  header alone -- no need to allocate 150 MB in a test. */
    const withDeclaredLength = (fetcher: typeof fetch, declaredLength: number): typeof fetch => (
        async (url, init) => {
            const res = await fetcher(url, init);
            if ((init?.method ?? 'GET') !== 'GET' || !res.ok) return res;
            return { ...res, headers: { get: (name: string) => (
                name.toLowerCase() === 'content-length' ? String(declaredLength) : res.headers.get(name)
            ) } } as Response;
        }
    ) as typeof fetch;

    const MB = 1024 * 1024;

    it('reads an encrypted sync document far larger than the per-attachment cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(9), FAST_KDF);
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher, material, expectedEtag: null });

        const result = await webdavGetSyncDocument<typeof data>(URL_, {
            fetcher: withDeclaredLength(fetcher, 150 * MB),
            material,
        });

        expect(result).toEqual({ state: 'data', data, exists: true, strongEtag: '"v1"' });
    });

    it('reads a plaintext sync document far larger than the per-attachment cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher, expectedEtag: null });

        const result = await webdavGetSyncDocument<typeof data>(URL_, {
            fetcher: withDeclaredLength(fetcher, 150 * MB),
        });

        expect(result).toEqual({ state: 'data', data, exists: true, strongEtag: '"v1"' });
    });

    it('still refuses a sync document beyond the document cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(9), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material, expectedEtag: null });

        await expect(webdavGetSyncDocument(URL_, {
            fetcher: withDeclaredLength(fetcher, 2 * 1024 * MB),
            material,
        })).rejects.toThrow(/download limit/);
    });
});
