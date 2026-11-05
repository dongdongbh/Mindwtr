import { describe, expect, it, vi } from 'vitest';

import { defaultSyncCryptoPrimitives, type SyncCryptoPrimitives } from './sync-crypto';
import {
    SyncEncryptionRemoteConflictError,
    isPlaintextSyncArtifact,
    type SyncEncryptionRemotePort,
} from './sync-encryption';
import { createSyncEncryptionStateStore, readSyncLocationScope } from './sync-encryption-local-state';
import { SyncRemoteMutationFenceLostError } from './sync-remote-fence';
import { SyncEncryptionCleanupDeferredError, createSyncEncryptionService } from './sync-encryption-service';
import {
    ATTACHMENT_PRESENCE_RECONCILE_KEY,
    CLOUD_PROVIDER_KEY,
    FAST_SYNC_STATE_KEY,
    SYNC_BACKEND_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    SYNC_ENCRYPTION_STATE_KEY,
    SYNC_PATH_KEY,
} from './sync-storage-keys';


const fastCrypto: SyncCryptoPrimitives = {
    ...defaultSyncCryptoPrimitives,
    argon2id: async (pass, salt, _params, dkLen) => Uint8Array.from(
        { length: dkLen },
        (_, index) => (pass[index % pass.length] ^ salt[index % salt.length] ^ index) & 0xff,
    ),
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));


const createMemoryFolder = (initial: Record<string, Uint8Array>) => {
    let generation = 0;
    const files = new Map<string, { bytes: Uint8Array; version: string }>();
    for (const [name, bytes] of Object.entries(initial)) files.set(name, { bytes, version: `v${++generation}` });
    const port: SyncEncryptionRemotePort = {
        list: async () => [
            { name: 'data.json', kind: 'document' },
            { name: 'data.json.enc', kind: 'document' },
            { name: 'data.json.bak', kind: 'document' },
            { name: 'data.json.enc.bak', kind: 'document' },
            ...[...files.keys()]
                .filter((name) => name.startsWith('attachments/'))
                .map((name) => ({ name, kind: 'attachment' as const })),
        ],
        read: async (name) => {
            const file = files.get(name);
            return file ? { bytes: file.bytes, version: file.version } : { bytes: null, version: null };
        },
        write: async (name, bytes, expectedVersion) => {
            if ((files.get(name)?.version ?? null) !== expectedVersion) throw new SyncEncryptionRemoteConflictError();
            files.set(name, { bytes, version: `v${++generation}` });
        },
        remove: async (name, expectedVersion) => {
            if (files.get(name)?.version !== expectedVersion) throw new SyncEncryptionRemoteConflictError();
            files.delete(name);
        },
    };
    return { files, port };
};

type Lease = { id: string };

const FENCE_NAME = '.mindwtr-sync-fence-v1.json';
const SERVER_DATE = 'Tue, 27 Aug 2026 12:00:00 GMT';


const createDropboxFolder = (initial: Record<string, Uint8Array>) => {
    const files = new Map(Object.entries(initial));
    const revs = new Map([...files.keys()].map((name) => [name, 1]));
    const requests: Array<{ endpoint: string; path: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const endpoint = url.slice(url.lastIndexOf('/files/') + '/files/'.length);
        const apiArg = new Headers(init?.headers).get('Dropbox-API-Arg');
        const body = apiArg ? JSON.parse(apiArg) : JSON.parse(String(init?.body ?? '{}'));
        const name = String(body.path ?? '').replace(/^\//, '');
        requests.push({ endpoint, path: name });
        const headers = { date: SERVER_DATE, 'content-type': 'application/json' };
        if (endpoint === 'list_folder') {
            const entries = [...files.keys()].filter((key) => key.startsWith('attachments/')).map((key) => ({
                '.tag': 'file', name: key.slice('attachments/'.length), path_lower: `/${key.toLowerCase()}`,
            }));
            return new Response(JSON.stringify({ entries, cursor: 'done', has_more: false }), { headers });
        }
        const rev = files.has(name) ? `rev${revs.get(name)}` : null;
        if (endpoint === 'download') {
            if (!rev) return new Response(JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), { status: 409, headers });
            return new Response(files.get(name)!.slice(), { headers: { date: SERVER_DATE, 'Dropbox-API-Result': JSON.stringify({ rev }) } });
        }
        if (endpoint === 'upload') {
            const mode = body.mode as { '.tag': string; update?: string };
            if ((mode['.tag'] === 'add' && rev) || (mode['.tag'] === 'update' && mode.update !== rev)) {
                return new Response('{}', { status: 409, headers });
            }
            files.set(name, new Uint8Array(init?.body as Uint8Array));
            revs.set(name, (revs.get(name) ?? 0) + 1);
            return new Response(JSON.stringify({ rev: `rev${revs.get(name)}` }), { headers });
        }
        if (endpoint === 'delete_v2') {
            if (!rev || body.parent_rev !== rev) return new Response('{}', { status: 409, headers });
            files.delete(name);
            return new Response('{}', { headers });
        }
        throw new Error(`unexpected Dropbox endpoint ${url}`);
    }) as unknown as typeof fetch;
    return { files, revs, requests, fetcher };
};

const createHarness = (
    backend: Record<string, string> = {},
    folder?: SyncEncryptionRemotePort | null,
    options: {
        maxEncryptedArtifactBytes?: number;
        webdavUrl?: string;
        dropboxClientId?: string;
        fetch?: typeof fetch;
        fenceOwnerId?: string;
    } = {},
) => {
    const plain = new Map<string, string>(Object.entries(backend));
    const secrets = new Map<string, string>();
    const logs: Array<{ level: string; message: string; extra: Record<string, string>; force?: boolean }> = [];
    const storage = {
        getItem: async (key: string) => plain.get(key) ?? null,
        setItem: async (key: string, value: string) => {
            plain.set(key, value);
        },
        removeItem: async (key: string) => {
            plain.delete(key);
        },
    };
    const state = createSyncEncryptionStateStore({
        storage,
        secureConfig: {
            getSecureConfigValue: async (key) => secrets.get(key) ?? null,
            setSecureConfigValue: async (key, value) => {
                secrets.set(key, value);
            },
            deleteSecureConfigValue: async (key) => {
                secrets.delete(key);
            },
        },
        readActiveScope: () => readSyncLocationScope(storage),
        log: {
            info: (message, context) => {
                logs.push({ level: 'info', message, extra: context.extra, force: context.force });
            },
            warn: (message, context) => {
                logs.push({ level: 'warn', message, extra: context.extra, force: context.force });
            },
        },
    });
    const fileSync = {
        acquireLease: vi.fn(async (syncPath: string): Promise<Lease> => ({ id: syncPath })),
        openRemotePort: vi.fn(async () => folder ?? null),
        revalidateLease: vi.fn(async (_lease: Lease) => undefined),
        releaseLease: vi.fn(async (_lease: Lease) => undefined),
        isLeaseIdentityLostError: (error: unknown) => error instanceof Error && error.name === 'LeaseIdentityLost',
    };
    const service = createSyncEncryptionService<Lease>({
        maxEncryptedArtifactBytes: options.maxEncryptedArtifactBytes,
        fenceOwnerId: options.fenceOwnerId,
        storage,
        state,
        crypto: fastCrypto,
        fetch: options.fetch ?? vi.fn(async () => {
            throw new Error('no network in this test');
        }) as unknown as typeof fetch,
        parseWebdavXml: () => {
            throw new Error('no XML in this test');
        },
        loadWebDavConfig: async () => options.webdavUrl ? { url: options.webdavUrl } : null,
        webDavRequestOptions: () => ({}),
        getDropboxClientId: async () => options.dropboxClientId ?? '',
        runDropboxAuthorized: (_clientId, operation) => operation('token'),
        fileSync,
    });
    const transitionLines = () => logs.filter((line) => line.message.includes('transition'));
    return { plain, secrets, logs, storage, state, fileSync, service, transitionLines };
};

describe('sync encryption service', () => {
    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid host capacity %s at construction', (capacity) => {
            expect(() => createHarness({}, undefined, { maxEncryptedArtifactBytes: capacity }))
                .toThrow('maxEncryptedArtifactBytes');
        },
    );

    it('binds the host capacity to WebDAV only, preserving uncapped File Sync and Dropbox', async () => {
        const file = createMemoryFolder({ 'data.json': encode({ tasks: ['more than ten bytes'] }) });
        const cap = 80;
        const harness = createHarness(
            { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' },
            file.port,
            { maxEncryptedArtifactBytes: cap, webdavUrl: 'https://example.com/data.json', dropboxClientId: 'app' },
        );
        const webdav = await harness.service.__testUtils.createWebdavRemotePort(null);
        const dropbox = await harness.service.__testUtils.createDropboxRemotePort(null);
        expect(webdav.maxEncryptedArtifactBytes).toBe(cap);
        expect(dropbox.maxEncryptedArtifactBytes).toBeUndefined();

        await harness.service.enableSyncEncryption('correct horse');
        expect(file.files.has('data.json.enc')).toBe(true);
        expect(file.files.get('data.json.enc')!.bytes.length).toBeGreaterThan(cap);
    });

    it('manages the key locally before any backend exists, and logs the transition forced', async () => {
        const { plain, secrets, service, transitionLines } = createHarness();

        await expect(service.isSyncEncryptionBackendPending()).resolves.toBe(true);
        await service.enableSyncEncryption('correct horse');

        expect(secrets.get(SYNC_ENCRYPTION_KEY_KEY)).toBeTruthy();
        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!).state).toBe('enabled');
        await expect(service.getSyncEncryptionStatus()).resolves.toMatchObject({ state: 'enabled' });
        const lines = transitionLines();
        expect(lines.map((line) => [line.extra.kind, line.extra.phase, line.force])).toEqual([
            ['enable-local-only', 'start', true],
            ['enable-local-only', 'end', true],
        ]);

        await service.disableSyncEncryption();
        expect(secrets.has(SYNC_ENCRYPTION_KEY_KEY)).toBe(false);
        await expect(service.getSyncEncryptionStatus()).resolves.toMatchObject({ state: 'off' });
    });

    it('refuses what needs a remote without one, and backends without encryption support', async () => {
        const noBackend = createHarness();
        await expect(noBackend.service.provideSyncEncryptionPassphrase('x')).rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');

        const selfHosted = createHarness({ [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'selfhosted' });
        await expect(selfHosted.service.enableSyncEncryption('x'))
            .rejects.toThrow('Sync encryption is only available for File Sync, WebDAV and Dropbox.');

        const webdav = createHarness({ [SYNC_BACKEND_KEY]: 'webdav' });
        await expect(webdav.service.enableSyncEncryption('x')).rejects.toThrow('WebDAV is not configured');
        expect(webdav.transitionLines()).toEqual([]);

        const dropbox = createHarness({ [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' });
        await expect(dropbox.service.changeSyncEncryptionPassphrase('a', 'b')).rejects.toThrow('Dropbox is not configured');
    });

    it('logs a no-backend unlock or passphrase change as backend-required, not error', async () => {
        const { service, transitionLines } = createHarness();

        await expect(service.provideSyncEncryptionPassphrase('x')).rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');
        await expect(service.changeSyncEncryptionPassphrase('a', 'b')).rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');

        expect(transitionLines().filter((line) => line.extra.phase === 'end').map((line) => [line.extra.kind, line.extra.outcome]))
            .toEqual([['unlock', 'backend-required'], ['change-passphrase', 'backend-required']]);
    });

    it('sends every Dropbox transition request, the fence included, through the host fetcher', async () => {

        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('the default fetch must not be used');
        }));
        try {
            const dropbox = createDropboxFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
            const { service } = createHarness(
                { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
                undefined,
                { dropboxClientId: 'app', fetch: dropbox.fetcher },
            );

            await service.enableSyncEncryption('correct horse');

            expect(isPlaintextSyncArtifact(dropbox.files.get('data.json.enc')!)).toBe(false);
            const endpoints = new Set(dropbox.requests.map((request) => `${request.endpoint}:${request.path}`));
            for (const expected of [`upload:${FENCE_NAME}`, `delete_v2:${FENCE_NAME}`, 'list_folder:attachments', 'download:data.json', 'upload:data.json.enc', 'delete_v2:data.json']) {
                expect(endpoints.has(expected)).toBe(true);
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([
        ['the default owner', undefined, 'mindwtr-mobile'],
        ['a host owner', 'mindwtr-desktop', 'mindwtr-desktop'],
    ])('writes %s into the transition fence a peer sees', async (_label, fenceOwnerId, expected) => {
        const dropbox = createDropboxFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
        const owners: string[] = [];
        const upload = dropbox.fetcher;
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const arg = new Headers(init?.headers).get('Dropbox-API-Arg');
            if (String(input).endsWith('/files/upload') && arg && JSON.parse(arg).path === `/${FENCE_NAME}`) {
                owners.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)).ownerId);
            }
            return upload(input, init);
        }) as typeof fetch;
        const { service } = createHarness(
            { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
            undefined,
            { dropboxClientId: 'app', fetch: fetcher, fenceOwnerId },
        );

        await service.enableSyncEncryption('correct horse');

        expect(owners.length).toBeGreaterThan(0);
        expect(new Set(owners)).toEqual(new Set([expected]));
    });

    it('restores the journal and the earlier key when the fence is lost after the final state write', async () => {
        const dropbox = createDropboxFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
        const { plain, secrets, service } = createHarness(
            { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
            undefined,
            {
                dropboxClientId: 'app',

                fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                    const arg = new Headers(init?.headers).get('Dropbox-API-Arg');
                    const committed = plain.get(SYNC_ENCRYPTION_STATE_KEY)?.includes('"enabled"')
                        && !plain.get(SYNC_ENCRYPTION_STATE_KEY)?.includes('incompleteTransition');
                    if (committed && String(input).endsWith('/files/download') && arg && JSON.parse(arg).path === `/${FENCE_NAME}`) {
                        dropbox.files.set(FENCE_NAME, encode({
                            schema: 1, leaseId: 'peer-lease', ownerId: 'peer', purpose: 'encryption-transition',
                            expiresAt: Date.parse(SERVER_DATE) + 60_000,
                        }));
                    }
                    return dropbox.fetcher(input, init);
                }) as typeof fetch,
            },
        );

        await expect(service.enableSyncEncryption('correct horse')).rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);

        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual({ state: 'off', incompleteTransition: 'enable' });
        expect(secrets.has(SYNC_ENCRYPTION_KEY_KEY)).toBe(false);
    });

    it('encrypts a File Sync folder under its lease and releases the lease once', async () => {
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
        const { fileSync, service, state } = createHarness(
            { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' },
            folder.port,
        );
        const progress: string[] = [];

        await service.enableSyncEncryption('correct horse', { onProgress: (p) => progress.push(p.phase) });

        expect(folder.files.has('data.json')).toBe(false);
        expect(isPlaintextSyncArtifact(folder.files.get('data.json.enc')!.bytes)).toBe(false);
        expect(fileSync.acquireLease).toHaveBeenCalledWith('/sync');
        expect(fileSync.revalidateLease).toHaveBeenCalled();
        expect(fileSync.releaseLease).toHaveBeenCalledTimes(1);
        expect(state.syncEncryptionLocalState.read()).toMatchObject({ state: 'enabled' });
        expect(progress).toContain('documents');
    });

    it('releases the lease when the folder cannot be opened', async () => {
        const { fileSync, service } = createHarness({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' }, null);

        await expect(service.enableSyncEncryption('x')).rejects.toThrow('Unable to open the sync folder');
        expect(fileSync.releaseLease).toHaveBeenCalledTimes(1);
    });

    it('reports a committed transition whose lock release failed as a file-lock cleanup', async () => {
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
        const { fileSync, service } = createHarness(
            { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' },
            folder.port,
        );
        fileSync.releaseLease.mockRejectedValueOnce(new Error('close failed'));

        const error = await service.enableSyncEncryption('correct horse').catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SyncEncryptionCleanupDeferredError);
        expect((error as SyncEncryptionCleanupDeferredError).cleanupKind).toBe('file-lock');
        expect(folder.files.has('data.json.enc')).toBe(true);
        expect(fileSync.releaseLease).toHaveBeenCalledTimes(1);
    });

    it('rolls the key and state back when the lock is lost before the release', async () => {
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [], projects: [] }) });
        const { fileSync, service, secrets, plain } = createHarness(
            { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' },
            folder.port,
        );
        const lost = Object.assign(new Error('lock replaced'), { name: 'LeaseIdentityLost' });
        fileSync.releaseLease.mockRejectedValueOnce(lost);

        await expect(service.enableSyncEncryption('correct horse')).rejects.toBe(lost);

        expect(secrets.has(SYNC_ENCRYPTION_KEY_KEY)).toBe(false);
        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!)).toMatchObject({ incompleteTransition: 'enable' });
    });

    it('"Abandon setup" turns this device off, forgets the key and the unfinished change, and contacts no location', async () => {
        const { plain, secrets, service, logs, fileSync, state } = createHarness({
            [SYNC_BACKEND_KEY]: 'file',
            [SYNC_PATH_KEY]: '/sync',
            [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'off', incompleteTransition: 'enable' }),
        });
        secrets.set(SYNC_ENCRYPTION_KEY_KEY, 'AAAA');
        await expect(service.getSyncEncryptionStatus()).resolves.toMatchObject({ incompleteTransition: 'enable' });

        await expect(service.abandonSyncEncryptionTransition()).resolves.toBe('enable');


        const scope = await readSyncLocationScope({ getItem: async (key: string) => plain.get(key) ?? null });
        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual({ state: 'off', partlyEncryptedScope: scope });
        await expect(state.isSyncEncryptionBlocked(scope)).resolves.toBe(true);
        await expect(state.isSyncEncryptionBlocked('["webdav","https://elsewhere.example/dav"]')).resolves.toBe(false);
        expect(secrets.has(SYNC_ENCRYPTION_KEY_KEY)).toBe(false);
        const status = await service.getSyncEncryptionStatus();
        expect(status.state).toBe('off');
        expect(status.incompleteTransition).toBeUndefined();
        expect(fileSync.acquireLease).not.toHaveBeenCalled();
        const line = logs.find((entry) => entry.extra.releaseCheck === 'v1.3.4/encryption-abandon-setup');
        expect(line).toMatchObject({ force: true, extra: { kind: 'abandon', abandoned: 'enable', outcome: 'ok' } });


        await expect(service.abandonSyncEncryptionTransition()).resolves.toBeNull();
    });

    it('reads a location an interrupted enable left half encrypted as mixed, and a whole one as plaintext or encrypted', async () => {
        const attachment = (name: string, at: number) => ({ id: name, kind: 'file', title: name, cloudKey: `attachments/${name}`, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', uri: '', at });
        const data = { tasks: [{ id: 't', title: 'x', attachments: ['a.bin', 'b.bin', 'c.bin'].map(attachment) }], projects: [] };
        const folder = createMemoryFolder({
            'data.json': encode(data),
            'attachments/a.bin': encode('a'), 'attachments/b.bin': encode('b'), 'attachments/c.bin': encode('c'),
        });
        const { service } = createHarness({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' }, folder.port);
        await expect(service.probeSyncLocationCiphertext()).resolves.toBe('plaintext');


        const write = folder.port.write;
        let writes = 0;
        folder.port.write = async (name, bytes, version) => {
            if (name.startsWith('attachments/') && ++writes > 1) throw new Error('the server went away');
            return write(name, bytes, version);
        };
        await expect(service.enableSyncEncryption('correct horse', { appData: data as never })).rejects.toThrow('the server went away');
        folder.port.write = write;
        expect(isPlaintextSyncArtifact(folder.files.get('attachments/a.bin')!.bytes)).toBe(false);
        expect(isPlaintextSyncArtifact(folder.files.get('data.json')!.bytes)).toBe(true);
        await expect(service.probeSyncLocationCiphertext()).resolves.toBe('mixed');
        await expect(service.probeSyncLocationCiphertext({ full: true })).resolves.toBe('mixed');
    });

    it('invalidates both completed-cycle proofs before a whole Recheck clears quarantine', async () => {
        const scope = '["file","/sync"]';
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [] }) });
        const { plain, service, storage, state, logs } = createHarness({
            [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync',
            [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'off', partlyEncryptedScope: scope }),
            [FAST_SYNC_STATE_KEY]: 'old completed cycle',
            [ATTACHMENT_PRESENCE_RECONCILE_KEY]: 'old completed attachment pass',
        }, folder.port);
        const removed: string[] = [];
        const remove = storage.removeItem;
        vi.spyOn(storage, 'removeItem').mockImplementation(async (key) => {
            if (key !== SYNC_ENCRYPTION_STATE_KEY) expect(plain.has(SYNC_ENCRYPTION_STATE_KEY)).toBe(true);
            else expect(removed).toEqual([FAST_SYNC_STATE_KEY, ATTACHMENT_PRESENCE_RECONCILE_KEY]);
            removed.push(key);
            await remove(key);
        });

        await expect(service.recheckPartlyEncryptedLocation()).resolves.toBe('plaintext');

        expect(removed).toEqual([FAST_SYNC_STATE_KEY, ATTACHMENT_PRESENCE_RECONCILE_KEY, SYNC_ENCRYPTION_STATE_KEY]);
        expect(plain.has(SYNC_ENCRYPTION_STATE_KEY)).toBe(false);
        await expect(state.isSyncEncryptionPostureUnestablished(scope, false)).resolves.toBe(true);
        expect(logs.filter((line) => line.extra.releaseCheck === 'v1.3.5/encryption-recheck-posture')).toEqual([
            expect.objectContaining({ force: true, extra: {
                kind: 'recheck', phase: 'end', outcome: 'ok', releaseCheck: 'v1.3.5/encryption-recheck-posture',
            } }),
        ]);
    });

    it.each([FAST_SYNC_STATE_KEY, ATTACHMENT_PRESENCE_RECONCILE_KEY])(
        'retains quarantine when removing %s fails, then allows a complete retry', async (failed) => {
            const quarantine = JSON.stringify({ state: 'off', partlyEncryptedScope: '["file","/sync"]' });
            const folder = createMemoryFolder({ 'data.json': encode({ tasks: [] }) });
            const { plain, service, storage, state, logs } = createHarness({
                [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync', [SYNC_ENCRYPTION_STATE_KEY]: quarantine,
                [FAST_SYNC_STATE_KEY]: 'old completed cycle',
                [ATTACHMENT_PRESENCE_RECONCILE_KEY]: 'old completed attachment pass',
            }, folder.port);
            const remove = storage.removeItem;
            const removals = vi.spyOn(storage, 'removeItem').mockImplementation(async (key) => {
                if (key === failed) throw new Error('durable proof removal failed');
                await remove(key);
            });

            await expect(service.recheckPartlyEncryptedLocation()).rejects.toThrow('durable proof removal failed');

            expect(plain.get(SYNC_ENCRYPTION_STATE_KEY)).toBe(quarantine);
            expect(state.syncEncryptionLocalState.read()?.partlyEncryptedScope).toBe('["file","/sync"]');
            expect(plain.has(ATTACHMENT_PRESENCE_RECONCILE_KEY)).toBe(true);
            expect(plain.has(FAST_SYNC_STATE_KEY)).toBe(failed === FAST_SYNC_STATE_KEY);
            expect(removals).not.toHaveBeenCalledWith(SYNC_ENCRYPTION_STATE_KEY);
            expect(logs.some((line) => line.extra.releaseCheck === 'v1.3.5/encryption-recheck-posture')).toBe(false);

            removals.mockImplementation(remove);
            await expect(service.recheckPartlyEncryptedLocation()).resolves.toBe('plaintext');
            expect(plain.has(FAST_SYNC_STATE_KEY)).toBe(false);
            expect(plain.has(ATTACHMENT_PRESENCE_RECONCILE_KEY)).toBe(false);
            expect(plain.has(SYNC_ENCRYPTION_STATE_KEY)).toBe(false);
        },
    );

    it('keeps both completed-cycle proofs and quarantine for a mixed Recheck', async () => {
        const scope = '["file","/sync"]';
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [] }), 'attachments/a.bin': encode('a') });
        const { plain, service, storage, state, logs } = createHarness({
            [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync',
            [FAST_SYNC_STATE_KEY]: 'old completed cycle',
            [ATTACHMENT_PRESENCE_RECONCILE_KEY]: 'old completed attachment pass',
        }, folder.port);
        const write = folder.port.write;
        folder.port.write = async (name, bytes, version) => {
            if (name === 'data.json.enc') throw new Error('the document write stopped');
            await write(name, bytes, version);
        };
        await expect(service.enableSyncEncryption('correct horse')).rejects.toThrow('the document write stopped');
        await service.abandonSyncEncryptionTransition();
        expect(state.syncEncryptionLocalState.read()?.partlyEncryptedScope).toBe(scope);
        const before = new Map(plain);
        const removals = vi.spyOn(storage, 'removeItem');

        await expect(service.recheckPartlyEncryptedLocation()).resolves.toBe('mixed');

        expect(plain).toEqual(before);
        expect(removals).not.toHaveBeenCalled();
        expect(logs.some((line) => line.extra.releaseCheck === 'v1.3.5/encryption-recheck-posture')).toBe(false);
    });

    it('does not fail a completed proof invalidation when its diagnostic rejects', async () => {
        const folder = createMemoryFolder({ 'data.json': encode({ tasks: [] }) });
        const { plain, service, state } = createHarness({
            [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync',
            [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'off', partlyEncryptedScope: '["file","/sync"]' }),
            [FAST_SYNC_STATE_KEY]: 'old completed cycle',
            [ATTACHMENT_PRESENCE_RECONCILE_KEY]: 'old completed attachment pass',
        }, folder.port);
        const log = state.logSyncEncryptionEvent;
        vi.spyOn(state, 'logSyncEncryptionEvent').mockImplementation((event, extra, options) => (
            extra.releaseCheck === 'v1.3.5/encryption-recheck-posture'
                ? Promise.reject(new Error('the diagnostic sink stopped')) : log(event, extra, options)
        ));

        await expect(service.recheckPartlyEncryptedLocation()).resolves.toBe('plaintext');
        expect(plain.has(FAST_SYNC_STATE_KEY)).toBe(false);
        expect(plain.has(ATTACHMENT_PRESENCE_RECONCILE_KEY)).toBe(false);
        expect(plain.has(SYNC_ENCRYPTION_STATE_KEY)).toBe(false);
    });

    it('"Not now" keeps the no-key state', async () => {
        const { plain, service } = createHarness({
            [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'remote-encrypted-no-key', discoveredScope: '["file","/sync"]' }),
        });

        await service.declineSyncEncryptionPassphrase();

        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!).state).toBe('remote-encrypted-no-key');
    });
});
