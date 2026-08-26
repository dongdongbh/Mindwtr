// Desktop's half of #1056 phase 2: the TS-driven seams (Dropbox always, WebDAV under a config
// override or the web build, and all three backends' attachment bytes). The Rust-driven seams
// — File Sync and native WebDAV — are covered by apps/desktop/src-tauri/src/sync.rs's tests.
//
// The Tauri layer is faked with an in-memory keyring + state sidecar so the transitions run
// end to end against real @mindwtr/core orchestration and real MWENC1 containers. Argon2id is
// replaced by a cheap deterministic stand-in: what is under test here is the wiring, and the
// KDF itself is already pinned by the shared TS/Rust interop fixtures.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptRemoteArtifactOrThrow, deriveSyncKeyMaterial, encryptSyncArtifact, inspectSyncArtifact, SyncEncryptionTerminalError } from '@mindwtr/core';

type NativeState = {
    state: 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';
    salt?: string;
    kdfParams?: { mKib: number; t: number; p: number };
    key?: string;
};

const native = vi.hoisted(() => ({
    state: { state: 'off' } as NativeState,
    calls: [] as string[],
    failingCommand: null as string | null,
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
                    ? { state: 'off', hasKey: false }
                    : { state: native.state.state, kdfParams: native.state.kdfParams, hasKey: Boolean(native.state.key) };
            case 'get_sync_encryption_key_material':
                // `remote-plaintext` still holds a key on purpose (see SYNC_ENCRYPTION_KEYED_STATES).
                return native.state.state !== 'off'
                    && native.state.state !== 'remote-encrypted-no-key'
                    && native.state.key
                    ? { key: native.state.key, salt: native.state.salt, kdfParams: native.state.kdfParams }
                    : null;
            case 'set_sync_encryption_key_material':
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

const createDropboxFetch = (store: ReturnType<typeof createBlobStore>) =>
    (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const arg = init?.headers
            ? JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '{}')
            : {};
        const key = (arg.path ?? '').replace(/^\//, '');
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

const createWebdavFetch = (store: ReturnType<typeof createBlobStore>, baseUrl: string) =>
    (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const key = url.startsWith(`${baseUrl}/`) ? url.slice(baseUrl.length + 1) : url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
            const bytes = store.files.get(key);
            if (!bytes) return new Response(null, { status: 404 });
            return new Response(bytes.slice() as unknown as BodyInit, {
                status: 200,
                headers: { etag: `"v${store.versions.get(key) ?? 1}"` },
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
    clearSyncEncryptionMaterialCache();
});

describe('Dropbox sync encryption transitions', () => {
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
