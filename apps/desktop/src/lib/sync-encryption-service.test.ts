


import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decryptRemoteArtifactOrThrow,
    deriveSyncKeyMaterial,
    encryptSyncArtifact,
    inspectSyncArtifact,
    runSyncEncryptionTransitionWithDiagnostics,
    SyncEncryptionBackendIncompatibleError,
    SyncEncryptionTerminalError,
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceLostError,
    SYNC_REMOTE_MUTATION_FENCE_NAME,
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

                return native.state.state !== 'off'
                    && native.state.state !== 'remote-encrypted-no-key'
                    && native.state.key
                    ? { key: native.state.key, salt: native.state.salt, kdfParams: native.state.kdfParams }
                    : null;
            case 'set_sync_encryption_key_material':
                if (native.failSetAfterKeyWriteOnce) {
                    native.failSetAfterKeyWriteOnce = false;


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

const appLog = vi.hoisted(() => ({
    logInfo: vi.fn(async () => null),
    logWarn: vi.fn(async () => null),
}));
vi.mock('./app-log', () => appLog);

const {
    classifySyncEncryptionFailure,
    clearSyncEncryptionMaterialCache,
    createDesktopSyncEncryptionService,
    desktopSyncCryptoPrimitives,
    getSyncEncryptionStatus,
    getSyncEncryptionMaterial,
    logSyncEncryptionEvent,
    markRemoteSyncEncryptionPlaintext,
    openAttachmentBytes,
    sealAttachmentBytes,
    SyncEncryptionCleanupDeferredError,
} = await import('./sync-encryption-service');

const BASE_URL = 'https://dav.example/sync';


const serviceFor = (backend: 'off' | 'webdav' | 'dropbox', fetcher: typeof fetch) =>
    createDesktopSyncEncryptionService({
        location: {
            readTarget: async () => ({ backend }),
            readLocationScope: async () => null,
            invalidateCycleProofs: async () => undefined,
        },
        fetch: fetcher,
        loadWebDavConfig: async () => ({ url: BASE_URL, username: 'u', password: 'p' }),
        webDavRequestOptions: (allowInsecureHttp) => ({ allowInsecureHttp, fetcher }),
        getDropboxClientId: async () => 'app-key',
        runDropboxAuthorized: (_clientId, operation) => operation('token'),
    });
const dropboxService = (fetcher: typeof fetch) => serviceFor('dropbox', fetcher);
const webdavService = (fetcher: typeof fetch) => serviceFor('webdav', fetcher);

const FENCE_PATH = `/${SYNC_REMOTE_MUTATION_FENCE_NAME}`;
const peerFence = () => jsonBytes({
    schema: 1,
    leaseId: 'peer-lease',
    ownerId: 'peer-device',
    purpose: 'encryption-transition',
    expiresAt: Date.parse(SERVER_DATE) + 60_000,
});


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

const SERVER_DATE = 'Tue, 27 Aug 2026 12:00:00 GMT';

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
                    path_lower: `/${name.toLowerCase()}`,
                    path_display: `/${name}`,
                    rev: `rev${store.versions.get(name) ?? 1}`,
                }));
            return new Response(JSON.stringify({ entries, cursor: 'done', has_more: false }), {
                status: 200,
                headers: { date: SERVER_DATE },
            });
        }
        if (url.endsWith('/files/download')) {
            const bytes = store.files.get(key);
            if (!bytes) {
                return new Response(JSON.stringify({
                    error: { '.tag': 'path', path: { '.tag': 'not_found' } },
                }), {
                    status: 409,
                    headers: { 'content-type': 'application/json', date: SERVER_DATE },
                });
            }
            return new Response(bytes.slice() as unknown as BodyInit, {
                status: 200,
                headers: {
                    date: SERVER_DATE,
                    'Dropbox-API-Result': JSON.stringify({ rev: `rev${store.versions.get(key) ?? 1}` }),
                },
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
    fenceEtagMode: 'strong' | 'same' = 'strong',
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
            if (!bytes) return new Response(null, { status: 404, headers: { date: SERVER_DATE } });
            const effectiveEtagMode = key === '.mindwtr-sync-fence-v1.json' && fenceEtagMode === 'strong'
                ? 'strong'
                : etagMode;
            return new Response(bytes.slice() as unknown as BodyInit, {
                status: 200,
                headers: effectiveEtagMode === 'missing'
                    ? { date: SERVER_DATE }
                    : {
                        date: SERVER_DATE,
                        etag: `${effectiveEtagMode === 'weak' ? 'W/' : ''}"v${store.versions.get(key) ?? 1}"`,
                    },
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


const watchDropboxPaths = (
    transport: typeof fetch,
    onRequest: (endpoint: string, path: string) => void,
) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const apiArg = new Headers(init?.headers).get('Dropbox-API-Arg');
    const body = url.endsWith('/files/delete_v2') ? JSON.parse(String(init?.body ?? '{}')) : {};
    const path = String((apiArg ? JSON.parse(apiArg).path : body.path) ?? '');
    onRequest(url.slice(url.lastIndexOf('/files/') + '/files/'.length), path);
    return transport(input, init);
}) as unknown as typeof fetch;

describe('Dropbox sync encryption transitions', () => {
    it('holds the provider fence through the durable local commit and then releases it', async () => {
        const store = seedRemote();
        const events: string[] = [];
        const fetcher = watchDropboxPaths(createDropboxFetch(store), (endpoint, path) => {
            if (path !== FENCE_PATH) return;
            if (endpoint === 'upload') events.push(`acquired:${native.state.state}`);
            if (endpoint === 'delete_v2') events.push(`released:${native.state.state}`);
        });

        await dropboxService(fetcher).enableSyncEncryption('correct horse battery');

        expect(events).toEqual(['acquired:off', 'acquired:off', 'released:enabled']);
        expect(store.files.has(SYNC_REMOTE_MUTATION_FENCE_NAME)).toBe(false);
    });

    it('stops before transition capture when a peer holds the provider fence', async () => {
        const store = seedRemote();
        store.files.set(SYNC_REMOTE_MUTATION_FENCE_NAME, peerFence());
        store.versions.set(SYNC_REMOTE_MUTATION_FENCE_NAME, 1);
        const baseline = new Map(Array.from(store.files, ([name, bytes]) => [name, bytes.slice()]));

        await expect(dropboxService(createDropboxFetch(store)).enableSyncEncryption('correct horse battery'))
            .rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);

        expect(store.files).toEqual(baseline);
        expect(native.state).toEqual({ state: 'off' });
    });

    it('reports a committed transition with cleanup deferred when the fence release fails', async () => {
        const store = seedRemote();
        const transport = createDropboxFetch(store);
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const body = String(input).endsWith('/files/delete_v2') ? JSON.parse(String(init?.body ?? '{}')) : {};
            if (body.path === FENCE_PATH) return new Response('{}', { status: 500 });
            return transport(input, init);
        }) as typeof fetch;

        const error = await dropboxService(fetcher).enableSyncEncryption('correct horse battery')
            .then(() => null, (failure: unknown) => failure);


        expect(error).toBeInstanceOf(SyncEncryptionCleanupDeferredError);
        expect(native.state.state).toBe('enabled');
        expect(isEncrypted(store.files.get('data.json.enc'))).toBe(true);
    });

    it('restores the prior material and journal when the lease is lost after final persistence', async () => {
        const store = seedRemote();
        const transport = createDropboxFetch(store);

        const fetcher = watchDropboxPaths(transport, (endpoint, path) => {
            if (endpoint === 'download' && path === FENCE_PATH && native.state.state === 'enabled') {
                store.files.set(SYNC_REMOTE_MUTATION_FENCE_NAME, peerFence());
            }
        });

        await expect(dropboxService(fetcher).enableSyncEncryption('correct horse battery'))
            .rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);

        expect(native.state).toEqual({ state: 'off', incompleteTransition: 'enable' });
        await expect(getSyncEncryptionMaterial()).resolves.toBeNull();
    });

    it('encrypts every artifact, removes the plaintext documents, and leaves attachment names alone', async () => {
        const store = seedRemote();

        await dropboxService(createDropboxFetch(store)).enableSyncEncryption('correct horse battery');

        expect(isEncrypted(store.files.get('data.json.enc'))).toBe(true);
        expect(isEncrypted(store.files.get('data.json.enc.bak'))).toBe(true);
        expect(store.files.has('data.json')).toBe(false);
        expect(store.files.has('data.json.bak')).toBe(false);

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

        await expect(dropboxService(fetcher).enableSyncEncryption('correct horse battery'))
            .rejects.toThrow('Dropbox artifact changed');

        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json')!))).toEqual(peerData);
        expect(store.files.has('data.json.enc')).toBe(true);
    });

    it('accepts the right passphrase and rejects the wrong one without touching the remote', async () => {
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));
        await service.enableSyncEncryption('correct horse battery');


        native.state = { state: 'remote-encrypted-no-key' };
        clearSyncEncryptionMaterialCache();
        const before = new Map(store.files);

        expect(await service.provideSyncEncryptionPassphrase('wrong one')).toBe('wrong-passphrase');
        expect(native.state.state).toBe('remote-encrypted-no-key');
        expect([...store.files.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [name, bytes] of before) expect(store.files.get(name)).toEqual(bytes);

        expect(await service.provideSyncEncryptionPassphrase('correct horse battery')).toBe('ok');
        expect((await getSyncEncryptionStatus()).state).toBe('enabled');
    });

    it('holds the provider fence through passphrase provisioning and the durable local commit', async () => {
        const store = seedRemote();
        const transport = createDropboxFetch(store);
        await dropboxService(transport).enableSyncEncryption('correct horse battery');
        native.state = { state: 'remote-encrypted-no-key' };
        clearSyncEncryptionMaterialCache();
        const events: string[] = [];
        const fetcher = watchDropboxPaths(transport, (endpoint, path) => {
            if (path !== FENCE_PATH) return;
            if (endpoint === 'upload') events.push(`acquired:${native.state.state}`);
            if (endpoint === 'delete_v2') events.push(`released:${native.state.state}`);
        });

        await expect(dropboxService(fetcher).provideSyncEncryptionPassphrase('correct horse battery'))
            .resolves.toBe('ok');

        expect(events).toEqual([
            'acquired:remote-encrypted-no-key',
            'acquired:remote-encrypted-no-key',
            'released:enabled',
        ]);
    });

    it('does not provision a key while a peer provider transition holds the fence', async () => {
        const store = seedRemote();
        const fetcher = createDropboxFetch(store);
        await dropboxService(fetcher).enableSyncEncryption('correct horse battery');
        native.state = { ...native.state, state: 'remote-encrypted-no-key', key: undefined };
        const previousState = structuredClone(native.state);
        clearSyncEncryptionMaterialCache();
        store.files.set(SYNC_REMOTE_MUTATION_FENCE_NAME, peerFence());
        store.versions.set(SYNC_REMOTE_MUTATION_FENCE_NAME, 1);

        await expect(dropboxService(fetcher).provideSyncEncryptionPassphrase('correct horse battery'))
            .rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);

        expect(native.state).toEqual(previousState);
        await expect(getSyncEncryptionMaterial()).resolves.toBeNull();
    });

    it('rolls back provisioned local material when the provider fence is lost before finalization', async () => {
        const store = seedRemote();
        const transport = createDropboxFetch(store);
        await dropboxService(transport).enableSyncEncryption('correct horse battery');
        native.state = { ...native.state, state: 'remote-encrypted-no-key', key: undefined };
        const previousState = structuredClone(native.state);
        clearSyncEncryptionMaterialCache();

        let fenceWrites = 0;
        const fetcher = watchDropboxPaths(transport, (endpoint, path) => {
            if (endpoint === 'upload' && path === FENCE_PATH && ++fenceWrites === 2) {
                store.files.set(SYNC_REMOTE_MUTATION_FENCE_NAME, peerFence());
                store.versions.set(SYNC_REMOTE_MUTATION_FENCE_NAME, (store.versions.get(SYNC_REMOTE_MUTATION_FENCE_NAME) ?? 1) + 1);
            }
        });

        await expect(dropboxService(fetcher).provideSyncEncryptionPassphrase('correct horse battery'))
            .rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);

        expect(native.state).toEqual(previousState);
        await expect(getSyncEncryptionMaterial()).resolves.toBeNull();
    });

    it('disable restores readable plaintext and clears the key', async () => {
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));
        await service.enableSyncEncryption('correct horse battery');

        await service.disableSyncEncryption();

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
        const service = dropboxService(createDropboxFetch(store));

        await service.enableSyncEncryption('old passphrase');
        expect(isEncrypted(store.files.get('data.json.enc.bak'))).toBe(true);
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);

        await service.changeSyncEncryptionPassphrase('old passphrase', 'new passphrase');
        const changedKey = base64ToBytes(native.state.key!);
        await expect(decryptRemoteArtifactOrThrow(
            store.files.get('attachments/a1.png')!,
            changedKey,
            desktopSyncCryptoPrimitives,
        )).resolves.toEqual(attachment);

        await service.disableSyncEncryption();
        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json.bak')!)))
            .toEqual(APP_DATA_WITH_ATTACHMENT);
        expect(store.files.get('attachments/a1.png')).toEqual(attachment);
    });

});

describe('WebDAV sync encryption transitions', () => {
    it('round-trips through the core service on the host fetcher', async () => {
        const store = seedRemote();
        const service = webdavService(createWebdavFetch(store, BASE_URL));

        await service.enableSyncEncryption('correct horse battery');
        expect(isEncrypted(store.files.get('data.json.enc'))).toBe(true);
        expect(store.files.has('data.json')).toBe(false);
        expect(isEncrypted(store.files.get('attachments/a1.png'))).toBe(true);

        await service.disableSyncEncryption();
        expect(JSON.parse(new TextDecoder().decode(store.files.get('data.json')!))).toEqual(
            APP_DATA_WITH_ATTACHMENT,
        );
    });


    it.each([
        ['missing', 'strong'],
        ['weak', 'strong'],
        ['missing', 'same'],
        ['weak', 'same'],
    ] as const)(
        'refuses a server with %s ETags (fence ETag %s) before writing the transition fence',
        async (etagMode, fenceEtagMode) => {
            const store = seedRemote();
            const snapshot = new Map([...store.files].map(([name, bytes]) => [name, bytes.slice()]));
            const fetcher = vi.fn(createWebdavFetch(store, BASE_URL, etagMode, fenceEtagMode));
            appLog.logWarn.mockClear();

            const refused = await webdavService(fetcher as unknown as typeof fetch)
                .enableSyncEncryption('correct horse battery')
                .then(() => null, (error: unknown) => error);

            expect(refused).toBeInstanceOf(SyncEncryptionBackendIncompatibleError);
            expect(String((refused as Error).message)).toMatch(/^SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE: /);
            expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/${SYNC_REMOTE_MUTATION_FENCE_NAME}`))).toBe(false);
            expect(fetcher.mock.calls.every(([, init]) => ['GET', 'PROPFIND'].includes(init?.method ?? 'GET'))).toBe(true);
            expect(store.files).toEqual(snapshot);
            expect(native.state).toEqual({ state: 'off' });

            expect(appLog.logWarn).toHaveBeenCalledWith(
                '[sync-encryption] transition',
                expect.objectContaining({
                    force: true,
                    extra: expect.objectContaining({
                        kind: 'enable',
                        backend: 'webdav',
                        phase: 'end',
                        errorName: 'SyncEncryptionBackendIncompatibleError',
                    }),
                }),
            );
        },
    );
});

describe('no backend yet (#1001)', () => {
    it('manages the key in Rust only, and refuses what needs a remote', async () => {
        const fetcher = vi.fn() as unknown as typeof fetch;
        const service = serviceFor('off', fetcher);

        await service.enableSyncEncryption('correct horse battery');
        expect(native.state.state).toBe('enabled');
        expect(native.state.key).toBeTruthy();
        await expect(service.provideSyncEncryptionPassphrase('correct horse battery'))
            .rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');

        await service.disableSyncEncryption();
        expect(native.state).toEqual({ state: 'off' });
        expect(fetcher).not.toHaveBeenCalled();
    });
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

        expect(await openAttachmentBytes(plain)).toBe(plain);
    });

    it('S3: fail closed on upload when local state says enabled but the keyring has no key', async () => {


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

        const truncated = new Uint8Array(20);
        truncated.set(new TextEncoder().encode('MWENC1'), 0);
        store.files.set('data.json.enc', truncated);

        const error = await dropboxService(createDropboxFetch(store)).enableSyncEncryption('correct horse battery')
            .then(() => null, (thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(SyncEncryptionTerminalError);
        expect(classifySyncEncryptionFailure(error)).toBe('needs-passphrase');
        expect(store.files.get('data.json.enc')).toEqual(truncated);
    });
});

describe('passphrase-change resume', () => {
    it('restores the prior native material after a partial state commit and retries after restart', async () => {
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));
        await service.enableSyncEncryption('old-pw');
        const previous = structuredClone(native.state);

        native.failSetAfterKeyWriteOnce = true;
        await expect(service.changeSyncEncryptionPassphrase('old-pw', 'new-pw'))
            .rejects.toThrow('local encryption state unavailable');


        clearSyncEncryptionMaterialCache();
        expect(native.state).toEqual({
            ...previous,
            incompleteTransition: 'change-passphrase',
        });
        await expect(getSyncEncryptionMaterial()).resolves.toMatchObject({
            key: base64ToBytes(previous.key!),
        });

        await expect(dropboxService(createDropboxFetch(store)).changeSyncEncryptionPassphrase('old-pw', 'new-pw'))
            .resolves.toBeUndefined();
        expect(native.state.state).toBe('enabled');
        expect(native.state.incompleteTransition).toBeUndefined();
        expect(native.state.key).not.toBe(previous.key);
    });

    it('finishes after an earlier attempt already rewrapped the base document under an abandoned salt', async () => {
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));
        await service.enableSyncEncryption('old-pw');
        const enabledKey = base64ToBytes(native.state.key!);


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

        await service.changeSyncEncryptionPassphrase('old-pw', 'new-pw');

        const finalKey = base64ToBytes(native.state.key!);


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

        expect(classifySyncEncryptionFailure('WebDAV GET failed (403): forbidden')).toBeNull();
        expect(classifySyncEncryptionFailure('Invalid sync payload shape: expected an object')).toBeNull();
    });
});


describe('sync-encryption diagnostics trail (#1056 follow-up)', () => {

    type LoggedCall = [string, { extra: Record<string, string> }];
    const capturedTrail = (): string => JSON.stringify(
        ([...appLog.logInfo.mock.calls, ...appLog.logWarn.mock.calls] as unknown as LoggedCall[])
            .filter((call) => typeof call[0] === 'string' && call[0].startsWith('[sync-encryption]')),
    );

    const hex = (bytes: Uint8Array) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

    beforeEach(() => {
        appLog.logInfo.mockClear();
        appLog.logWarn.mockClear();
    });


    describe('attachment byte seams', () => {
        it('precedes a failing attachment decrypt (no key) with a remote-read line', async () => {
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
            appLog.logInfo.mockClear();
            appLog.logWarn.mockClear();

            await expect(openAttachmentBytes(sealed)).rejects.toBeInstanceOf(SyncEncryptionTerminalError);

            const trail = capturedTrail();
            expect(trail).toContain('[sync-encryption] remote-read');
            expect(trail).toContain('"decision":"no-key"');
            expect(trail).toContain('"kind":"encrypted"');
        });

        it('precedes a failing attachment decrypt (unsupported container) with a remote-read line', async () => {
            const truncated = new Uint8Array(20);
            truncated.set(new TextEncoder().encode('MWENC1'));

            await expect(openAttachmentBytes(truncated)).rejects.toBeInstanceOf(SyncEncryptionTerminalError);

            const trail = capturedTrail();
            expect(trail).toContain('[sync-encryption] remote-read');
            expect(trail).toContain('"kind":"unsupported"');
        });

        it('logs a remote-read line for an ordinary successful seal and decrypt', async () => {
            native.state = {
                state: 'enabled',
                key: bytesToBase64(new Uint8Array(32).fill(7)),
                salt: '00'.repeat(16),
                kdfParams: { mKib: 19456, t: 2, p: 1 },
            };
            clearSyncEncryptionMaterialCache();

            const sealed = await sealAttachmentBytes(new Uint8Array([1, 2, 3]));
            await openAttachmentBytes(sealed);

            const trail = capturedTrail();
            expect(trail).toContain('"decision":"seal"');
            expect(trail).toContain('"decision":"decrypt"');
        });

        it('logs a plaintext seal (encryption off) without upgrading it to a failure line', async () => {
            const bytes = new Uint8Array([9, 8, 7]);

            expect(await sealAttachmentBytes(bytes)).toBe(bytes);

            const trail = capturedTrail();
            expect(trail).toContain('"decision":"seal"');
            expect(trail).toContain('"kind":"plaintext"');
        });


        it('names the attachment on both the seal and the open line', async () => {
            native.state = {
                state: 'enabled',
                key: bytesToBase64(new Uint8Array(32).fill(7)),
                salt: '00'.repeat(16),
                kdfParams: { mKib: 19456, t: 2, p: 1 },
            };
            clearSyncEncryptionMaterialCache();

            const sealed = await sealAttachmentBytes(new Uint8Array([1, 2, 3]), 'attachments/att-1.txt');
            await openAttachmentBytes(sealed, 'attachments/att-1.txt');

            const trail = capturedTrail();
            expect(trail).toContain('"artifact":"att-1.txt"');
            expect(trail).not.toContain('"artifact":"absent"');
        });
    });

    it('never puts the passphrase or the derived key into an enable/unlock line', async () => {
        const passphrase = 'correct horse battery staple';
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));

        await service.enableSyncEncryption(passphrase);
        clearSyncEncryptionMaterialCache();
        await service.provideSyncEncryptionPassphrase(passphrase);

        const material = await getSyncEncryptionMaterial();
        expect(material).not.toBeNull();

        const trail = capturedTrail();

        expect(trail).toContain('[sync-encryption] transition');
        expect(trail).toContain('"kind":"enable"');
        expect(trail).toContain('"kind":"unlock"');
        expect(trail).toContain('"outcome":"ok"');
        expect(trail).toContain('"backend":"cloud"');

        expect(trail).not.toContain(passphrase);
        expect(trail).not.toContain(hex(material!.key));
        expect(trail).not.toContain(bytesToBase64(material!.key));

        expect(trail).not.toContain(hex(material!.salt));
    });

    it('clamps a transition failure message instead of logging it whole', async () => {
        const longMessage = `/home/someone/very/long/sync/folder/path/${'x'.repeat(400)}`;


        await expect(runSyncEncryptionTransitionWithDiagnostics(logSyncEncryptionEvent, 'disable', 'file', undefined, async () => {
            throw new Error(longMessage);
        })).rejects.toThrow();

        const trail = capturedTrail();
        expect(trail).toContain('"outcome":"error"');
        expect(trail).not.toContain(longMessage);
        const logged = JSON.parse(trail) as LoggedCall[];
        const errorMessages = logged
            .map(([, context]) => context.extra.errorMessage)
            .filter((value): value is string => typeof value === 'string' && value !== '-');
        expect(errorMessages).toHaveLength(1);
        expect(errorMessages[0]!.length).toBeLessThanOrEqual(201);
    });

    it('logs one progress line per completed transition phase, with planned and done filled', async () => {


        const store = seedRemote();
        const progress = vi.fn();
        await dropboxService(createDropboxFetch(store)).enableSyncEncryption(
            'correct horse battery staple',
            { onProgress: progress },
        );
        expect(progress).toHaveBeenCalled();

        const logged = JSON.parse(capturedTrail()) as LoggedCall[];
        const phases = logged.map(([, context]) => context.extra).filter((extra) => extra.phase === 'artifact');
        expect(phases.map((extra) => extra.artifact)).toEqual(['attachments', 'documents']);
        for (const extra of phases) {
            expect(Number(extra.planned)).toBeGreaterThan(0);
            expect(Number(extra.done)).toBeGreaterThan(0);
            expect(Number(extra.done)).toBeLessThanOrEqual(Number(extra.planned));
        }

        const finalPhase = phases[phases.length - 1]!;
        expect(finalPhase.done).toBe(finalPhase.planned);
    });

    it('reports a wrong passphrase as an outcome, not as the passphrase', async () => {
        const store = seedRemote();
        const service = dropboxService(createDropboxFetch(store));
        await service.enableSyncEncryption('correct horse battery');
        clearSyncEncryptionMaterialCache();
        appLog.logInfo.mockClear();
        appLog.logWarn.mockClear();

        await service.provideSyncEncryptionPassphrase('not the passphrase at all');

        const trail = capturedTrail();
        expect(trail).toContain('"outcome":"wrong-passphrase"');
        expect(trail).not.toContain('not the passphrase at all');
    });

    it('marks every desktop transition that ran through the core service', async () => {
        const store = seedRemote();

        await dropboxService(createDropboxFetch(store)).enableSyncEncryption('correct horse battery');

        expect(appLog.logInfo).toHaveBeenCalledWith(
            'Sync encryption state loaded for the core service',
            { scope: 'sync', extra: { releaseCheck: 'v1.3.5/desktop-encryption-core-service' }, force: true },
        );
    });
});
