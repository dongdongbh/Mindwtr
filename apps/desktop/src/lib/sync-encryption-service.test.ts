// Desktop's half of #1056 phase 2: the TS-driven seams (Dropbox always, WebDAV under a config
// override or the web build, and all three backends' attachment bytes). The Rust-driven seams
// — File Sync and native WebDAV — are covered by apps/desktop/src-tauri/src/sync.rs's tests.
//
// The Tauri layer is faked with an in-memory keyring + state sidecar so the transitions run
// end to end against real @mindwtr/core orchestration and real MWENC1 containers. Argon2id is
// replaced by a cheap deterministic stand-in: what is under test here is the wiring, and the
// KDF itself is already pinned by the shared TS/Rust interop fixtures.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decryptRemoteArtifactOrThrow,
    deriveSyncKeyMaterial,
    encryptSyncArtifact,
    inspectSyncArtifact,
    SyncEncryptionRemoteVersionUnavailableError,
    SyncEncryptionTerminalError,
} from '@mindwtr/core';

type NativeState = {
    state: 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';
    salt?: string;
    kdfParams?: { mKib: number; t: number; p: number };
    key?: string;
    incompleteTransition?: 'enable' | 'disable' | 'change-passphrase';
};

const native = vi.hoisted(() => ({
    state: { state: 'off' } as NativeState,
    calls: [] as string[],
    failingCommand: null as string | null,
    failSetAfterKeyWriteOnce: false,
}));

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array =>
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

vi.mock('./tauri-invoke', () => {
    const derive = async (passphrase: string, saltHex: string) => {
        // Stand-in KDF: deterministic in (passphrase, salt), 32 bytes, no Argon2 cost.
        const seed = new TextEncoder().encode(`${passphrase}:${saltHex}`);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
        return bytesToBase64(digest);
    };
    const invoke = async (command: string, args?: Record<string, unknown>) => {
        native.calls.push(command);
        if (native.failingCommand === command) throw new Error('local encryption state unavailable');
        switch (command) {
            case 'get_sync_encryption_status':
                return native.state.state === 'off'
                    ? { state: 'off', hasKey: false, incompleteTransition: native.state.incompleteTransition }
                    : { state: native.state.state, kdfParams: native.state.kdfParams, hasKey: Boolean(native.state.key), incompleteTransition: native.state.incompleteTransition };
            case 'get_sync_encryption_key_material':
                // `remote-plaintext` still holds a key on purpose (see SYNC_ENCRYPTION_KEYED_STATES).
                return native.state.state !== 'off'
                    && native.state.state !== 'remote-encrypted-no-key'
                    && native.state.key
                    ? { key: native.state.key, salt: native.state.salt, kdfParams: native.state.kdfParams }
                    : null;
            case 'set_sync_encryption_key_material':
                if (native.failSetAfterKeyWriteOnce) {
                    native.failSetAfterKeyWriteOnce = false;
                    // Rust stores the keyring entry before replacing its state
                    // sidecar. Model a sidecar failure at that exact boundary.
                    native.state = { ...native.state, key: args?.key as string };
                    throw new Error('local encryption state unavailable');
                }
                native.state = {
                    state: 'enabled',
                    key: args?.key as string,
                    salt: args?.salt as string,
                    kdfParams: args?.kdfParams as NativeState['kdfParams'],
                };
                return null;
            case 'clear_sync_encryption_key_material':
                native.state = { state: 'off' };
                return null;
            case 'mark_sync_encryption_transition_incomplete':
                native.state = {
                    ...native.state,
                    incompleteTransition: args?.transitionKind as NativeState['incompleteTransition'],
                };
                return null;
            case 'mark_sync_encryption_remote_plaintext':
                if (native.state.state === 'enabled') {
                    native.state = { ...native.state, state: 'remote-plaintext' };
                }
                return null;
            case 'mark_sync_encryption_remote_discovered':
                if (native.state.state !== 'enabled') {
                    native.state = {
                        state: 'remote-encrypted-no-key',
                        salt: args?.salt as string,
                        kdfParams: args?.kdfParams as NativeState['kdfParams'],
                    };
                }
                return null;
            case 'derive_sync_encryption_key': {
                const salt = (args?.salt as string) ?? '00'.repeat(16);
                return {
                    key: await derive(args?.passphrase as string, salt),
                    salt,
                    kdfParams: args?.kdfParams ?? { mKib: 19456, t: 2, p: 1 },
                };
            }
            default:
                throw new Error(`unexpected command ${command}`);
        }
    };
    return {
        invokeNative: invoke,
        invokeNativeOr: async (_fallback: unknown, command: string, args?: Record<string, unknown>) =>
            invoke(command, args),
    };
});

const {
    classifySyncEncryptionFailure,
    clearSyncEncryptionMaterialCache,
    __syncEncryptionServiceTestUtils,
    createDropboxRemotePort,
    createWebdavRemotePort,
    desktopSyncCryptoPrimitives,
    getSyncEncryptionStatus,
    getSyncEncryptionMaterial,
    markRemoteSyncEncryptionPlaintext,
    runChangePassphraseOverRemote,
    openAttachmentBytes,
    runDisableOverRemote,
    runEnableOverRemote,
    runProvidePassphraseOverRemote,
    sealAttachmentBytes,
} = await import('./sync-encryption-service');

/** A blob store both fakes serve from, keyed exactly the way the remote names it. */
const createBlobStore = (seed: Record<string, Uint8Array>) => {
    const files = new Map<string, Uint8Array>(Object.entries(seed));
    const versions = new Map<string, number>(Object.keys(seed).map((name) => [name, 1]));
    return { files, versions };
};

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const APP_DATA_WITH_ATTACHMENT = {
    tasks: [
        {
            id: 't1',
            title: 'has an attachment',
            attachments: [{ id: 'a1', kind: 'file', cloudKey: 'attachments/a1.png' }],
        },
    ],
    projects: [],
};

const seedRemote = () =>
    createBlobStore({
        'data.json': jsonBytes(APP_DATA_WITH_ATTACHMENT),
        'data.json.bak': jsonBytes({ tasks: [], projects: [] }),
        'attachments/a1.png': new Uint8Array([1, 2, 3, 4, 5]),
    });

const davResponseXml = (
    href: string,
    options: { collection?: boolean; status?: number } = {},
): string => {
    const status = options.status ?? 200;
    return '<d:response>'
        + `<d:href>${href}</d:href>`
        + '<d:propstat><d:prop><d:resourcetype>'
        + (options.collection ? '<d:collection/>' : '')
        + `</d:resourcetype></d:prop><d:status>HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}</d:status></d:propstat>`
        + '</d:response>';
};

const davMultistatusXml = (...responses: string[]): string =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;

const createDropboxFetch = (store: ReturnType<typeof createBlobStore>) =>
    (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const arg = init?.headers
            ? JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '{}')
            : {};
        const key = (arg.path ?? '').replace(/^\//, '');
        if (url.endsWith('/files/list_folder')) {
            const entries = Array.from(store.files.keys())
                .filter((name) => name.startsWith('attachments/'))
                .map((name) => ({
                    '.tag': 'file',
                    name: name.slice('attachments/'.length),
                    path_display: `/${name}`,
                    rev: `rev${store.versions.get(name) ?? 1}`,
                }));
            return new Response(JSON.stringify({ entries, cursor: 'done', has_more: false }), { status: 200 });
        }
        if (url.endsWith('/files/download')) {
            const bytes = store.files.get(key);
            if (!bytes) {
                return new Response(JSON.stringify({
                    error: { '.tag': 'path', path: { '.tag': 'not_found' } },
                }), { status: 409, headers: { 'content-type': 'application/json' } });
            }
            return new Response(bytes.slice() as unknown as BodyInit, {
                status: 200,
                headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `rev${store.versions.get(key) ?? 1}` }) },
            });
        }
        if (url.endsWith('/files/upload')) {
            const currentRev = store.files.has(key) ? `rev${store.versions.get(key) ?? 1}` : null;
            const mode = arg.mode as { '.tag'?: string; update?: string } | undefined;
            if ((mode?.['.tag'] === 'add' && currentRev)
                || (mode?.['.tag'] === 'update' && mode.update !== currentRev)) {
                return new Response('{}', { status: 409 });
            }
            const body = init?.body as ArrayBuffer | Uint8Array | string;
            const bytes =
                typeof body === 'string'
                    ? new TextEncoder().encode(body)
                    : body instanceof Uint8Array
                        ? new Uint8Array(body)
                        : new Uint8Array(body);
            store.files.set(key, bytes);
            const next = (store.versions.get(key) ?? 0) + 1;
            store.versions.set(key, next);
            return new Response(JSON.stringify({ rev: `rev${next}` }), { status: 200 });
        }
        if (url.endsWith('/files/delete_v2')) {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const path = body.path.replace(/^\//, '');
            const currentRev = store.files.has(path) ? `rev${store.versions.get(path) ?? 1}` : null;
            if (!currentRev || body.parent_rev !== currentRev) return new Response('{}', { status: 409 });
            store.files.delete(path);
            store.versions.delete(path);
            return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected Dropbox endpoint ${url}`);
    }) as unknown as typeof fetch;

const createWebdavFetch = (
    store: ReturnType<typeof createBlobStore>,
    baseUrl: string,
    etagMode: 'strong' | 'weak' | 'missing' = 'strong',
) =>
    (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const key = url.startsWith(`${baseUrl}/`) ? url.slice(baseUrl.length + 1) : url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PROPFIND') {
            const responses = [
                davResponseXml(`${baseUrl}/attachments/`, { collection: true }),
                ...Array.from(store.files.keys())
                    .filter((name) => name.startsWith('attachments/'))
                    .map((name) => davResponseXml(`${baseUrl}/${name}`)),
            ];
            return new Response(
                davMultistatusXml(...responses),
                { status: 207, headers: { 'content-type': 'application/xml' } },
            );
        }
        if (method === 'GET') {
            const bytes = store.files.get(key);
            if (!bytes) return new Response(null, { status: 404 });
            return new Response(bytes.slice() as unknown as BodyInit, {
                status: 200,
                headers: etagMode === 'missing'
                    ? undefined
                    : { etag: `${etagMode === 'weak' ? 'W/' : ''}"v${store.versions.get(key) ?? 1}"` },
            });
        }
        if (method === 'PUT') {
            const headers = new Headers(init?.headers);
            const currentEtag = store.files.has(key) ? `"v${store.versions.get(key) ?? 1}"` : null;
            if ((headers.get('if-none-match') === '*' && currentEtag)
                || (headers.has('if-match') && headers.get('if-match') !== currentEtag)) {
                return new Response(null, { status: 412 });
            }
            const body = init?.body as Uint8Array | string;
            store.files.set(
                key,
                typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
            );
            store.versions.set(key, (store.versions.get(key) ?? 0) + 1);
            return new Response(null, { status: 201 });
        }
        if (method === 'DELETE') {
            const currentEtag = store.files.has(key) ? `"v${store.versions.get(key) ?? 1}"` : null;
            if (!currentEtag || new Headers(init?.headers).get('if-match') !== currentEtag) {
                return new Response(null, { status: 412 });
            }
            store.files.delete(key);
            store.versions.delete(key);
            return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected WebDAV ${method} ${url}`);
    }) as unknown as typeof fetch;

const isEncrypted = (bytes: Uint8Array | undefined) =>
    Boolean(bytes) && inspectSyncArtifact(bytes as Uint8Array).kind === 'encrypted';

beforeEach(() => {
    native.state = { state: 'off' };
    native.calls = [];
    native.failingCommand = null;
    native.failSetAfterKeyWriteOnce = false;
    clearSyncEncryptionMaterialCache();
});

describe('WebDAV authoritative attachment inventory', () => {
    const baseUrl = 'https://dav.example/sync';
    const collectionUrl = `${baseUrl}/attachments/`;

    it('requires the exact collection response and excludes child collections', () => {
        const xml = davMultistatusXml(
            davResponseXml(collectionUrl, { collection: true }),
            davResponseXml(`${collectionUrl}folder/`, { collection: true }),
            davResponseXml(`${collectionUrl}a.bin`),
        );

        expect(__syncEncryptionServiceTestUtils.parseWebdavAttachmentKeys(xml, collectionUrl))
            .toEqual(['attachments/a.bin']);
    });

    it.each([
        ['malformed XML', '<d:multistatus xmlns:d="DAV:"><d:response>'],
        ['missing collection response', davMultistatusXml(davResponseXml(`${collectionUrl}a.bin`))],
        ['unmatched href', davMultistatusXml(
            davResponseXml(collectionUrl, { collection: true }),
            davResponseXml('https://other.example/attachments/a.bin'),
        )],
        ['ambiguous href', davMultistatusXml(
            `<d:response><d:href>${collectionUrl}</d:href><d:href>${collectionUrl}a.bin</d:href>`
            + '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
            + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
        )],
        ['failed propstat', davMultistatusXml(
            davResponseXml(collectionUrl, { collection: true }),
            davResponseXml(`${collectionUrl}a.bin`, { status: 403 }),
        )],
    ] as const)('fails closed on %s', (_case, xml) => {
        expect(() => __syncEncryptionServiceTestUtils.parseWebdavAttachmentKeys(xml, collectionUrl))
            .toThrow(/WebDAV attachment inventory/);
    });

    it.each([403, 404])('fails closed on an HTTP %s collection response', async (status) => {
        const fetcher = vi.fn(async () => new Response(null, { status }));
        await expect(__syncEncryptionServiceTestUtils.listWebdavAttachmentKeys(baseUrl, { fetcher }))
            .rejects.toThrow(`PROPFIND failed (${status})`);
    });

    it('does not write any transition artifact when collection validation fails', async () => {
        const store = seedRemote();
        const baseline = new Map(Array.from(store.files, ([name, bytes]) => [name, bytes.slice()]));
        const transport = createWebdavFetch(store, baseUrl);
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
            (init?.method ?? 'GET').toUpperCase() === 'PROPFIND'
                ? new Response(null, { status: 403 })
                : transport(input, init)
        ));

        await expect(runEnableOverRemote(
            'passphrase',
            createWebdavRemotePort({ baseUrl, options: { fetcher } }),
        )).rejects.toThrow('PROPFIND failed (403)');

        expect(fetcher.mock.calls.every(([, init]) => ['GET', 'PROPFIND'].includes((init?.method ?? 'GET').toUpperCase())))
            .toBe(true);
        expect(store.files).toEqual(baseline);
        expect(native.state).toEqual({ state: 'off' });
    });
});

describe('Dropbox sync encryption transitions', () => {
    it('paginates the provider attachment inventory and filters unmanaged entries', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                entries: [
                    { '.tag': 'file', name: 'first.bin', path_display: '/attachments/first.bin' },
                    { '.tag': 'folder', name: 'nested', path_display: '/attachments/nested' },
                    { '.tag': 'file', name: '../victim', path_display: '/attachments/../victim' },
                ],
                cursor: 'page-2',
                has_more: true,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                entries: [
                    { '.tag': 'file', name: 'second.bin', path_display: '/attachments/second.bin' },
                ],
                cursor: 'done',
                has_more: false,
            }), { status: 200 }));

        await expect(__syncEncryptionServiceTestUtils.listDropboxAttachmentKeys('token', fetcher))
            .resolves.toEqual(['attachments/first.bin', 'attachments/second.bin']);
        expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ cursor: 'page-2' });
    });

    it('encrypts every artifact, removes the plaintext documents, and leaves attachment names alone', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        const port = createDropboxRemotePort((operation) => operation('token'), fetcher);

        await runEnableOverRemote('correct horse battery', port);

        expect(isEncrypted(store.files.get('data.json.enc'))).toBe(true);
        expect(isEncrypted(store.files.get('data.json.enc.bak'))).toBe(true);
        expect(store.files.has('data.json')).toBe(false);
        expect(store.files.has('data.json.bak')).toBe(false);
        // Attachments keep their exact name — cloudKey is identity-keyed and immutable.
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);
        expect(await getSyncEncryptionStatus()).toEqual({
            state: 'enabled',
            kdfParams: expect.objectContaining({ mKib: expect.any(Number) }),
        });
    });

    it('CASes the exact document generation used to derive the attachment inventory', async () => {
        const store = seedRemote();
        const baseFetcher = createDropboxFetch(store);
        const peerData = {
            ...APP_DATA_WITH_ATTACHMENT,
            tasks: [{ ...APP_DATA_WITH_ATTACHMENT.tasks[0], title: 'peer-updated task' }],
        };
        let peerAdvancedDocument = false;
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await baseFetcher(input, init);
            const apiArg = init?.headers
                ? JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '{}')
                : {};
            if (
                !peerAdvancedDocument
                && String(input).endsWith('/files/download')
                && apiArg.path === '/data.json'
                && response.ok
            ) {
                peerAdvancedDocument = true;
                store.files.set('data.json', jsonBytes(peerData));
                store.versions.set('data.json', (store.versions.get('data.json') ?? 1) + 1);
            }
            return response;
        }) as typeof fetch;

        await expect(runEnableOverRemote(
            'correct horse battery',
            createDropboxRemotePort((operation) => operation('token'), fetcher),
        )).rejects.toThrow('Dropbox artifact changed');

        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json')!))).toEqual(peerData);
        expect(store.files.has('data.json.enc')).toBe(true);
    });

    it('accepts the right passphrase and rejects the wrong one without touching the remote', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await runEnableOverRemote('correct horse battery', createDropboxRemotePort((o) => o('token'), fetcher));

        // A second device: knows the remote is encrypted, has no key.
        native.state = { state: 'remote-encrypted-no-key' };
        clearSyncEncryptionMaterialCache();
        const before = new Map(store.files);
        const noKeyPort = createDropboxRemotePort((o) => o('token'), fetcher);

        expect(await runProvidePassphraseOverRemote('wrong one', noKeyPort)).toBe('wrong-passphrase');
        expect(native.state.state).toBe('remote-encrypted-no-key');
        expect([...store.files.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [name, bytes] of before) expect(store.files.get(name)).toEqual(bytes);

        expect(await runProvidePassphraseOverRemote('correct horse battery', noKeyPort)).toBe('ok');
        expect((await getSyncEncryptionStatus()).state).toBe('enabled');
    });

    it('disable restores readable plaintext and clears the key', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await runEnableOverRemote('correct horse battery', createDropboxRemotePort((o) => o('token'), fetcher));

        await runDisableOverRemote(createDropboxRemotePort((o) => o('token'), fetcher));

        expect(store.files.has('data.json.enc')).toBe(false);
        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json')!))).toEqual(
            APP_DATA_WITH_ATTACHMENT,
        );
        expect(store.files.get('attachments/a1.png')).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(await getSyncEncryptionStatus()).toEqual({ state: 'off' });
    });

    it('uses a backup-only document as the attachment authority through enable, change, and disable', async () => {
        const attachment = new Uint8Array([6, 5, 4, 3]);
        const store = createBlobStore({
            'data.json.bak': jsonBytes(APP_DATA_WITH_ATTACHMENT),
            'attachments/a1.png': attachment,
        });
        const fetcher = createDropboxFetch(store);

        await runEnableOverRemote(
            'old passphrase',
            createDropboxRemotePort((operation) => operation('token'), fetcher),
        );
        expect(isEncrypted(store.files.get('data.json.enc.bak'))).toBe(true);
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);

        await runChangePassphraseOverRemote(
            'old passphrase',
            'new passphrase',
            createDropboxRemotePort((operation) => operation('token'), fetcher),
        );
        const changedKey = base64ToBytes(native.state.key!);
        await expect(decryptRemoteArtifactOrThrow(
            store.files.get('attachments/a1.png')!,
            changedKey,
            desktopSyncCryptoPrimitives,
        )).resolves.toEqual(attachment);

        await runDisableOverRemote(createDropboxRemotePort((operation) => operation('token'), fetcher));
        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json.bak')!)))
            .toEqual(APP_DATA_WITH_ATTACHMENT);
        expect(store.files.get('attachments/a1.png')).toEqual(attachment);
    });

    it('unions attachment references from every readable current and backup document', async () => {
        const documents = new Map<string, Uint8Array>([
            ['data.json', jsonBytes({
                tasks: [{ id: 'current', attachments: [{ cloudKey: 'attachments/current.png' }] }],
                projects: [],
            })],
            ['data.json.bak', jsonBytes({
                tasks: [],
                projects: [{ id: 'backup', attachments: [{ cloudKey: 'attachments/backup.png' }] }],
            })],
        ]);
        const reads: string[] = [];
        const inventory = await __syncEncryptionServiceTestUtils.captureRemoteInventory(
            async (name: string) => {
                reads.push(name);
                const bytes = documents.get(name) ?? null;
                return { bytes, version: bytes ? `version:${name}` : null };
            },
            async () => [],
        );

        expect(inventory.referencedAttachmentKeys).toEqual([
            'attachments/backup.png',
            'attachments/current.png',
        ]);
        expect(inventory.entries.filter((entry) => entry.kind === 'attachment').map((entry) => entry.name))
            .toEqual(['attachments/backup.png', 'attachments/current.png']);
        expect(reads).toEqual(expect.arrayContaining(['attachments/backup.png', 'attachments/current.png']));
    });

    it('migrates an unreferenced attachment discovered by the provider inventory', async () => {
        const orphan = new Uint8Array([9, 7, 5, 3]);
        const store = createBlobStore({
            'data.json': jsonBytes({ tasks: [], projects: [] }),
            'attachments/orphan.bin': orphan,
        });
        const fetcher = createDropboxFetch(store);

        await runEnableOverRemote(
            'old passphrase',
            createDropboxRemotePort((operation) => operation('token'), fetcher),
        );
        expect(isEncrypted(store.files.get('attachments/orphan.bin'))).toBe(true);

        await runChangePassphraseOverRemote(
            'old passphrase',
            'new passphrase',
            createDropboxRemotePort((operation) => operation('token'), fetcher),
        );
        await runDisableOverRemote(createDropboxRemotePort((operation) => operation('token'), fetcher));
        expect(store.files.get('attachments/orphan.bin')).toEqual(orphan);
    });

    it('a re-run after an interrupted enable converges instead of starting a second generation', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await runEnableOverRemote('correct horse battery', createDropboxRemotePort((o) => o('token'), fetcher));
        const sealedDocument = store.files.get('data.json.enc')!;

        // A crash between "wrote the .enc" and "removed the plaintext" leaves both generations.
        store.files.set('data.json.bak', jsonBytes({ tasks: [], projects: [] }));
        await runEnableOverRemote('correct horse battery', createDropboxRemotePort((o) => o('token'), fetcher));

        expect(store.files.has('data.json.bak')).toBe(false);
        // The already-sealed base document was recognized as migrated and left untouched.
        expect(store.files.get('data.json.enc')).toEqual(sealedDocument);
    });
});

describe('WebDAV sync encryption transitions (config-override / web path)', () => {
    it('rejects unmanaged artifact names before issuing a request', async () => {
        const fetcher = vi.fn();
        const port = createWebdavRemotePort({
            baseUrl: 'https://dav.example/sync',
            options: { fetcher: fetcher as unknown as typeof fetch, username: 'u', password: 'p' },
        });

        expect(() => port.read('../victim')).toThrow('Invalid sync encryption remote artifact name');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('derives only managed blob attachment names from untrusted remote metadata', () => {
        const cloudKeys = [
            '../victim',
            'attachments/%2e%2e/victim',
            '/absolute',
            'https://evil.example/victim',
            'data.json',
            'cloudkit:asset',
            'attachments/valid.bin',
        ];
        const data = {
            tasks: [{ attachments: cloudKeys.map((cloudKey, index) => ({ id: `a${index}`, kind: 'file', cloudKey })) }],
            projects: [],
        } as unknown as Parameters<typeof __syncEncryptionServiceTestUtils.collectRemoteAttachmentKeys>[0];

        expect(__syncEncryptionServiceTestUtils.collectRemoteAttachmentKeys(data)).toEqual([
            'attachments/valid.bin',
        ]);
    });

    it('round-trips through the same core orchestration', async () => {
        const baseUrl = 'https://dav.example/sync';
        const store = seedRemote();
        const options = { fetcher: createWebdavFetch(store, baseUrl), username: 'u', password: 'p' };
        const port = createWebdavRemotePort({ baseUrl, options });

        await runEnableOverRemote('correct horse battery', port);
        expect(isEncrypted(store.files.get('data.json.enc'))).toBe(true);
        expect(store.files.has('data.json')).toBe(false);
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);

        await runDisableOverRemote(createWebdavRemotePort({ baseUrl, options }));
        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json')!))).toEqual(
            APP_DATA_WITH_ATTACHMENT,
        );
    });

    it('round-trips attachments when only the backup document is available', async () => {
        const baseUrl = 'https://dav.example/sync';
        const attachment = new Uint8Array([8, 6, 4, 2]);
        const store = createBlobStore({
            'data.json.bak': jsonBytes(APP_DATA_WITH_ATTACHMENT),
            'attachments/a1.png': attachment,
        });
        const options = { fetcher: createWebdavFetch(store, baseUrl), username: 'u', password: 'p' };

        await runEnableOverRemote('old passphrase', createWebdavRemotePort({ baseUrl, options }));
        expect(isEncrypted(store.files.get('data.json.enc.bak'))).toBe(true);
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);

        await runChangePassphraseOverRemote(
            'old passphrase',
            'new passphrase',
            createWebdavRemotePort({ baseUrl, options }),
        );
        await runDisableOverRemote(createWebdavRemotePort({ baseUrl, options }));

        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json.bak')!)))
            .toEqual(APP_DATA_WITH_ATTACHMENT);
        expect(store.files.get('attachments/a1.png')).toEqual(attachment);
    });

    it('migrates an unreferenced attachment from the WebDAV collection inventory', async () => {
        const baseUrl = 'https://dav.example/sync';
        const orphan = new Uint8Array([1, 3, 5, 7]);
        const store = createBlobStore({
            'data.json': jsonBytes({ tasks: [], projects: [] }),
            'attachments/orphan.bin': orphan,
        });
        const options = { fetcher: createWebdavFetch(store, baseUrl), username: 'u', password: 'p' };

        await runEnableOverRemote('old passphrase', createWebdavRemotePort({ baseUrl, options }));
        expect(isEncrypted(store.files.get('attachments/orphan.bin'))).toBe(true);

        await runChangePassphraseOverRemote(
            'old passphrase',
            'new passphrase',
            createWebdavRemotePort({ baseUrl, options }),
        );
        await runDisableOverRemote(createWebdavRemotePort({ baseUrl, options }));
        expect(store.files.get('attachments/orphan.bin')).toEqual(orphan);
    });

    it.each(['missing', 'weak'] as const)(
        'fails closed when existing WebDAV bytes have a %s ETag',
        async (etagMode) => {
            const baseUrl = 'https://dav.example/sync';
            const store = seedRemote();
            const snapshot = new Map([...store.files].map(([name, bytes]) => [name, bytes.slice()]));
            const options = {
                fetcher: createWebdavFetch(store, baseUrl, etagMode),
                username: 'u',
                password: 'p',
            };

            await expect(runEnableOverRemote(
                'correct horse battery',
                createWebdavRemotePort({ baseUrl, options }),
            )).rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);

            expect(store.files).toEqual(snapshot);
            expect(native.state).toEqual({ state: 'off' });
        },
    );
});

describe('attachment bytes', () => {
    it('propagates native encryption-state read failures instead of treating them as off', async () => {
        native.failingCommand = 'get_sync_encryption_status';

        await expect(getSyncEncryptionMaterial()).rejects.toThrow('local encryption state unavailable');
    });

    it('are a no-op while encryption is off', async () => {
        const bytes = new Uint8Array([9, 8, 7]);
        expect(await sealAttachmentBytes(bytes)).toBe(bytes);
        expect(await openAttachmentBytes(bytes)).toBe(bytes);
    });

    it('round-trip once a key is cached, and plaintext still passes through', async () => {
        native.state = {
            state: 'enabled',
            key: bytesToBase64(new Uint8Array(32).fill(7)),
            salt: '00'.repeat(16),
            kdfParams: { mKib: 19456, t: 2, p: 1 },
        };
        clearSyncEncryptionMaterialCache();

        const plain = new Uint8Array([1, 2, 3]);
        const sealed = await sealAttachmentBytes(plain);
        expect(isEncrypted(sealed)).toBe(true);
        expect(await openAttachmentBytes(sealed)).toEqual(plain);
        // A peer on an older app version can still upload plaintext mid-transition.
        expect(await openAttachmentBytes(plain)).toBe(plain);
    });

    it('S3: fail closed on upload when local state says enabled but the keyring has no key', async () => {
        // Simulates Android/OS-keyring invalidation: local state still says 'enabled'
        // (the sidecar file), but the keyring read comes back empty.
        native.state = {
            state: 'enabled',
            kdfParams: { mKib: 19456, t: 2, p: 1 },
        };
        clearSyncEncryptionMaterialCache();

        await expect(sealAttachmentBytes(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
            SyncEncryptionTerminalError,
        );
    });

    it('fail closed, and record the discovery, when the bytes are encrypted and there is no key', async () => {
        native.state = {
            state: 'enabled',
            key: bytesToBase64(new Uint8Array(32).fill(7)),
            salt: '00'.repeat(16),
            kdfParams: { mKib: 19456, t: 2, p: 1 },
        };
        clearSyncEncryptionMaterialCache();
        const sealed = await sealAttachmentBytes(new Uint8Array([1, 2, 3]));

        native.state = { state: 'off' };
        clearSyncEncryptionMaterialCache();
        await expect(openAttachmentBytes(sealed)).rejects.toBeInstanceOf(SyncEncryptionTerminalError);
        expect(native.state.state).toBe('remote-encrypted-no-key');
    });

    it('fails closed for an unsupported MWENC1 attachment container', async () => {
        const truncated = new Uint8Array(20);
        truncated.set(new TextEncoder().encode('MWENC1'));

        await expect(openAttachmentBytes(truncated)).rejects.toBeInstanceOf(
            SyncEncryptionTerminalError,
        );
    });
});

describe('unsupported base document', () => {
    it('classifies a truncated container as terminal instead of throwing a raw JSON parse error', async () => {
        const store = seedRemote();
        // Magic present, header short: neither plaintext to parse nor ciphertext to open.
        const truncated = new Uint8Array(20);
        truncated.set(new TextEncoder().encode('MWENC1'), 0);
        store.files.set('data.json.enc', truncated);

        const error = await runEnableOverRemote('correct horse battery', createDropboxRemotePort((o) => o('token'), createDropboxFetch(store)))
            .then(() => null, (thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(SyncEncryptionTerminalError);
        expect(classifySyncEncryptionFailure(error)).toBe('needs-passphrase');
        expect(store.files.get('data.json.enc')).toEqual(truncated);
    });
});

describe('passphrase-change resume', () => {
    it('restores the prior native material after a partial state commit and retries after restart', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await runEnableOverRemote('old-pw', createDropboxRemotePort((o) => o('token'), fetcher));
        const previous = structuredClone(native.state);

        native.failSetAfterKeyWriteOnce = true;
        await expect(runChangePassphraseOverRemote(
            'old-pw',
            'new-pw',
            createDropboxRemotePort((o) => o('token'), fetcher),
        )).rejects.toThrow('local encryption state unavailable');

        // Simulate a new webview: the native key and state must still describe
        // the original material, with the retry journal retained.
        clearSyncEncryptionMaterialCache();
        expect(native.state).toEqual({
            ...previous,
            incompleteTransition: 'change-passphrase',
        });
        await expect(getSyncEncryptionMaterial()).resolves.toMatchObject({
            key: base64ToBytes(previous.key!),
        });

        await expect(runChangePassphraseOverRemote(
            'old-pw',
            'new-pw',
            createDropboxRemotePort((o) => o('token'), fetcher),
        )).resolves.toBeUndefined();
        expect(native.state.state).toBe('enabled');
        expect(native.state.incompleteTransition).toBeUndefined();
        expect(native.state.key).not.toBe(previous.key);
    });

    it('finishes after an earlier attempt already rewrapped the base document under an abandoned salt', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await runEnableOverRemote('old-pw', createDropboxRemotePort((o) => o('token'), fetcher));
        const enabledKey = base64ToBytes(native.state.key!);

        // The interrupted attempt: attachments run first, then the documents, so a crash after
        // the base document means EVERY artifact is already sealed under that attempt's own
        // (now abandoned) salt, and the cached key opens none of them.
        const abandoned = await deriveSyncKeyMaterial(
            'new-pw',
            new Uint8Array(16).fill(0xab),
            { mKib: 19456, t: 2, p: 1 },
            desktopSyncCryptoPrimitives,
        );
        const sealedNames = ['attachments/a1.png', 'data.json.enc', 'data.json.enc.bak'];
        for (const name of sealedNames) {
            const plain = await decryptRemoteArtifactOrThrow(store.files.get(name)!, enabledKey, desktopSyncCryptoPrimitives);
            store.files.set(name, await encryptSyncArtifact(plain, abandoned, desktopSyncCryptoPrimitives));
        }

        await runChangePassphraseOverRemote('old-pw', 'new-pw', createDropboxRemotePort((o) => o('token'), fetcher));

        const finalKey = base64ToBytes(native.state.key!);
        // Every artifact — the attachment included — must be readable under the key the run
        // settled on. An enumeration that silently returned no attachments would leave
        // attachments/a1.png stranded under a salt nothing ever derives again.
        for (const name of sealedNames) {
            await expect(
                decryptRemoteArtifactOrThrow(store.files.get(name)!, finalKey, desktopSyncCryptoPrimitives),
            ).resolves.toBeInstanceOf(Uint8Array);
        }
        expect(store.files.get('attachments/a1.png')).not.toEqual(await encryptSyncArtifact(new Uint8Array([1, 2, 3, 4, 5]), abandoned, desktopSyncCryptoPrimitives));
    });
});

describe('failure classification', () => {
    it('persists remote-plaintext without disturbing the cached key', async () => {
        native.state = {
            state: 'enabled',
            key: bytesToBase64(new Uint8Array(32).fill(7)),
            salt: '00'.repeat(16),
            kdfParams: { mKib: 19456, t: 2, p: 1 },
        };
        clearSyncEncryptionMaterialCache();

        await markRemoteSyncEncryptionPlaintext();

        expect(native.state.state).toBe('remote-plaintext');
        // The key must survive: running the disable transition is the only way out and needs it.
        expect(native.state.key).toBeTruthy();
    });

    it('maps decrypt failures to a passphrase signal and leaves everything else alone', () => {
        expect(classifySyncEncryptionFailure('SYNC_ENCRYPTION_TERMINAL: wrong passphrase or corrupted data'))
            .toBe('needs-passphrase');
        expect(classifySyncEncryptionFailure('SYNC_ENCRYPTION_STATE_UNAVAILABLE: invalid local state'))
            .toBe('local-state-unavailable');
        expect(classifySyncEncryptionFailure('SYNC_ENCRYPTION_REMOTE_ENCRYPTED'))
            .toBe('remote-encrypted-no-key');
        expect(classifySyncEncryptionFailure('SYNC_ENCRYPTION_REMOTE_PLAINTEXT'))
            .toBe('remote-plaintext');
        expect(classifySyncEncryptionFailure(new Error('SYNC_ENCRYPTION_TERMINAL: nope')))
            .toBe('needs-passphrase');
        // The two failure classes it must never be confused with.
        expect(classifySyncEncryptionFailure('WebDAV GET failed (403): forbidden')).toBeNull();
        expect(classifySyncEncryptionFailure('Invalid sync payload shape: expected an object')).toBeNull();
    });
});
