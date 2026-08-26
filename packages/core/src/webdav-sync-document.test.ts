import { describe, expect, it } from 'vitest';
import { webdavGetSyncDocument, webdavPutSyncDocument } from './webdav';
import { deriveSyncKeyMaterial } from './sync-crypto';

const FAST_KDF = { mKib: 8, t: 1, p: 1 };

/** Minimal in-memory fake WebDAV server: GET/PUT keyed by URL, byte-accurate. */
function createFakeWebdavServer() {
    const files = new Map<string, Uint8Array>();
    const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const key = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
            const bytes = files.get(key);
            if (!bytes) {
                return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null } as unknown as Headers, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) } as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => null } as unknown as Headers,
                text: async () => new TextDecoder().decode(bytes),
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            } as Response;
        }
        if (method === 'PUT') {
            const bodyBytes = init!.body instanceof ArrayBuffer
                ? new Uint8Array(init!.body)
                : init!.body instanceof Uint8Array
                    ? init!.body
                    : new TextEncoder().encode(init!.body as string);
            files.set(key, bodyBytes);
            return { ok: true, status: 201, statusText: 'Created', headers: { get: () => null } as unknown as Headers, text: async () => '' } as Response;
        }
        throw new Error(`unsupported method ${method} in fake webdav server`);
    };
    return { files, fetcher };
}

const URL_ = 'https://example.com/dav/data.json';

describe('webdav sync-document encryption', () => {
    it('encrypts on PUT to the .enc url and decrypts on GET, leaving the plain url untouched', async () => {
        const { files, fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(1), FAST_KDF);
        const data = { tasks: [] };

        await webdavPutSyncDocument(URL_, data, { fetcher, material });
        expect(files.has(`${URL_}.enc`)).toBe(true);
        expect(files.has(URL_)).toBe(false);

        const result = await webdavGetSyncDocument<typeof data>(URL_, { fetcher, material });
        expect(result).toEqual({ state: 'data', data });
    });

    it('off-state path is unchanged: plain JSON at the plain url with no material', async () => {
        const { files, fetcher } = createFakeWebdavServer();
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher });
        expect(files.has(URL_)).toBe(true);
        expect(new TextDecoder().decode(files.get(URL_)!)).toBe(JSON.stringify(data, null, 2));
        const result = await webdavGetSyncDocument<typeof data>(URL_, { fetcher });
        expect(result).toEqual({ state: 'data', data });
    });

    it('an off-state device discovers an encrypted-but-plaintext-deleted remote instead of treating it as empty', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(2), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material });

        const result = await webdavGetSyncDocument(URL_, { fetcher }); // no material — this device is 'off'
        expect(result.state).toBe('encrypted-no-key');
        if (result.state === 'encrypted-no-key') {
            expect(result.salt.length).toBe(16);
        }
    });

    it('a wrong key fails closed on GET instead of returning garbage', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(3), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material });
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
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material: remoteMaterial });

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
        expect(result).toEqual({ state: 'data', data: null });
    });

    // Mirror of the off-state discovery above, in the other direction: a peer DISABLED
    // encryption at the sync location, so the `.enc` artifact is gone and a plaintext
    // document is back. Reporting "empty" here would merge this device's whole store into a
    // fresh remote generation and fork the two silently.
    it('an enabled device treats a peer-disabled (plaintext-restored) remote as terminal, not as empty', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(4), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher }); // the peer's plaintext write

        const result = await webdavGetSyncDocument(URL_, { fetcher, material });
        expect(result.state).toBe('remote-plaintext');
    });

    it('an enabled device still reports an empty remote when neither artifact exists', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(5), FAST_KDF);
        expect(await webdavGetSyncDocument(URL_, { fetcher, material })).toEqual({ state: 'data', data: null });
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
                name.toLowerCase() === 'content-length' ? String(declaredLength) : null
            ) } } as Response;
        }
    ) as typeof fetch;

    const MB = 1024 * 1024;

    it('reads an encrypted sync document far larger than the per-attachment cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(9), FAST_KDF);
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher, material });

        const result = await webdavGetSyncDocument<typeof data>(URL_, {
            fetcher: withDeclaredLength(fetcher, 150 * MB),
            material,
        });

        expect(result).toEqual({ state: 'data', data });
    });

    it('reads a plaintext sync document far larger than the per-attachment cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const data = { tasks: [] };
        await webdavPutSyncDocument(URL_, data, { fetcher });

        const result = await webdavGetSyncDocument<typeof data>(URL_, {
            fetcher: withDeclaredLength(fetcher, 150 * MB),
        });

        expect(result).toEqual({ state: 'data', data });
    });

    it('still refuses a sync document beyond the document cap', async () => {
        const { fetcher } = createFakeWebdavServer();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(9), FAST_KDF);
        await webdavPutSyncDocument(URL_, { tasks: [] }, { fetcher, material });

        await expect(webdavGetSyncDocument(URL_, {
            fetcher: withDeclaredLength(fetcher, 2 * 1024 * MB),
            material,
        })).rejects.toThrow(/download limit/);
    });
});
