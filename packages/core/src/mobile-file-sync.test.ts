import { describe, expect, it } from 'vitest';

import { FILE_SYNC_ABSENT_FINGERPRINT, createMobileFileSync, type MobileFileSyncFullHost } from './mobile-file-sync';
import { FileSyncPathOwnerTerminatedError, fileSyncErrorCode, type MobileFileSyncObservedPublication } from './mobile-file-sync-remote';
import { defaultSyncCryptoPrimitives, decryptSyncArtifact, deriveSyncKeyMaterial, encryptSyncArtifact } from './sync-crypto';
import { runUpgradeSyncEncryptionOverRemote } from './sync-encryption';
import { toRemoteSyncDocument } from './sync-document';
import { compareSyncTransitionEntryNames, runChangeSyncEncryptionPassphraseOverRemote, runDisableSyncEncryptionOverRemote, runEnableSyncEncryptionOverRemote, SyncEncryptionRemoteConflictError, type SyncEncryptionLocalState } from './sync-encryption';
import type { AppData } from './types';


const PRIVATE = 'private-folder';
const PATH_DIR = `file:///data/user/0/tech.dongdongbh.mindwtr/files/${PRIVATE}`;
const SAF_TREE = `content://com.android.externalstorage.documents/tree/primary%3A${PRIVATE}`;
const safChild = (name: string) => `${SAF_TREE}/document/primary%3A${PRIVATE}%2F${encodeURIComponent(name)}`;
const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

type Logged = { level: string; message: string; context: unknown };

const fakeHost = (overrides: Partial<MobileFileSyncFullHost>) => {
    const logged: Logged[] = [];
    const host = {
        os: () => 'android',
        saf: null,
        path: null,
        bookmarks: { supported: () => false, readText: async () => null },
        log: {
            info: (message: string, context: unknown) => logged.push({ level: 'info', message, context }),
            warn: (message: string, context: unknown) => logged.push({ level: 'warn', message, context }),

            error: (error: unknown, context: unknown) => logged.push({
                level: 'error',
                message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
                context,
            }),
        },
        encryption: { localState: {}, flush: async () => undefined, logEvent: () => undefined },
        crypto: {},
        ...overrides,
    } as unknown as MobileFileSyncFullHost;
    return { host, logged, contexts: () => JSON.stringify(logged.map((entry) => entry.context)), all: () => JSON.stringify(logged) };
};


const pathFolder = (refuse?: (name: string) => boolean) => {
    const files = new Map<string, Uint8Array>();
    const leaf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
    const deny = (uri: string) => { if (refuse?.(leaf(uri))) throw new Error(`EACCES: permission denied, open '${uri}'`); };
    return {
        files,
        port: {
            exists: (uri: string) => files.has(uri),
            info: async (uri: string) => ({ exists: files.has(uri) || [...files.keys()].some((key) => key.startsWith(`${uri}/`)), size: files.get(uri)?.length }),
            list: async (dir: string) => [...files.keys()].filter((key) => key.startsWith(`${dir}/`)).map(leaf),
            readBytes: async (uri: string) => files.get(uri) ?? null,
            readText: async (uri: string) => (files.has(uri) ? new TextDecoder().decode(files.get(uri)) : null),
            writeBytes: async (uri: string, bytes: Uint8Array) => { deny(uri); files.set(uri, bytes); },
            createExclusive: async (uri: string) => {
                deny(uri);
                if (files.has(uri)) return 'exists' as const;
                files.set(uri, new Uint8Array(0));
                return 'created' as const;
            },
            writeCreated: (uri: string, bytes: Uint8Array) => { files.set(uri, bytes); },
            delete: async (uri: string) => { files.delete(uri); },
            rename: (uri: string, name: string) => {
                const target = `${uri.slice(0, uri.lastIndexOf('/'))}/${name}`;
                if (files.has(target)) throw new Error(`EEXIST ${target}`);
                files.set(target, files.get(uri)!);
                files.delete(uri);
                return target;
            },
        },
    };
};

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
};

const observe = <T>(promise: Promise<T>) => {
    let settled = false;
    const result = promise.then(
        (value): { state: 'fulfilled'; value: T } => { settled = true; return { state: 'fulfilled', value }; },
        (reason: unknown): { state: 'rejected'; reason: unknown } => { settled = true; return { state: 'rejected', reason }; },
    );
    return { result, get settled() { return settled; } };
};

const nextTurn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe('encryption upgrade retained-generation identities', () => {
    it('records original nested display-name paths through the actual mobile remote port', async () => {
        const folder = pathFolder();
        const originalName = '.mindwtr-encryption-quarantine-fixture/.mindwtr-encryption-stage-inner/data.json.enc';
        const original = new TextEncoder().encode('historical bytes to preserve');
        const material = await deriveSyncKeyMaterial('phrase', new Uint8Array(16).fill(4), { mKib: 64, t: 1, p: 1 });
        folder.files.set(`${PATH_DIR}/data.json.enc`, await encryptSyncArtifact(
            new TextEncoder().encode(JSON.stringify(toRemoteSyncDocument(data))), material, defaultSyncCryptoPrimitives, { kind: 'document' }));
        folder.files.set(`${PATH_DIR}/${originalName}`, original);
        const { host } = fakeHost({ os: () => 'ios', crypto: defaultSyncCryptoPrimitives, path: {
            ...folder.port,
            exists: (uri) => folder.files.has(uri) || [...folder.files.keys()].some((path) => path.startsWith(`${uri}/`)),
            list: async (directory) => [...new Set([...folder.files.keys()]
                .filter((path) => path.startsWith(directory.endsWith('/') ? directory : `${directory}/`))
                .map((path) => path.slice(directory.endsWith('/') ? directory.length : directory.length + 1).split('/')[0]))],
        } });
        const remote = await createMobileFileSync(host).createFileSyncEncryptionRemotePort(`${PATH_DIR}/data.json`);
        if (!remote) throw new Error('Expected a File Sync remote port');
        expect((await remote.list()).find((entry) => entry.originalName === originalName)?.name)
            .toMatch(/^\.mindwtr-desktop-recovery-entry-/);
        let state: SyncEncryptionLocalState | null = { state: 'enabled' };
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => data, remote,
            { getKey: async () => material.key, setKey: async () => {}, clearKey: async () => {} },
            { read: () => state, write: async (next) => { state = next; } });
        const inventory = [...folder.files].find(([path]) => path.includes('.mindwtr-legacy-inventory-'));
        if (!inventory) throw new Error('Expected an encrypted recovery inventory');
        const mapping = JSON.parse(new TextDecoder().decode(await decryptSyncArtifact(inventory[1], material.key,
            defaultSyncCryptoPrimitives, { kind: 'recovery', artifactName: 'legacy-inventory' })));
        expect(mapping).toContainEqual(expect.objectContaining({ name: originalName, encoding: 'recovery-v2' }));
        expect(JSON.stringify(mapping)).not.toContain('.mindwtr-desktop-recovery-entry-');
        expect(JSON.stringify(mapping)).not.toContain('file://');
        expect(folder.files.has(`${PATH_DIR}/${originalName}`)).toBe(false);
    });
});

describe('promise-capable File Sync path ports', () => {
    const fileUri = `${PATH_DIR}/data.json`;
    const placeholderUri = `${PATH_DIR}/.data.json.icloud`;

    it.each([true, false])('awaits the real-file existence result %s before reading or checking its placeholder', async (exists) => {
        const folder = pathFolder();
        folder.files.set(fileUri, new TextEncoder().encode(JSON.stringify(data)));
        const entered = deferred<void>();
        const gate = deferred<boolean>();
        const lookups: string[] = [];
        const reads: string[] = [];
        const { host } = fakeHost({ os: () => 'ios', path: {
            ...folder.port,
            exists: (uri) => {
                lookups.push(uri);
                if (uri === fileUri) { entered.resolve(undefined); return gate.promise; }
                return false;
            },
            readText: async (uri) => { reads.push(uri); return folder.port.readText(uri); },
        } });
        const operation = observe(createMobileFileSync(host).readSyncFile(fileUri));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            expect(lookups).toEqual([fileUri]);
            expect(reads).toEqual([]);
            gate.resolve(exists);
            expect(await operation.result).toMatchObject({ state: 'fulfilled', value: data });
            expect(lookups).toEqual(exists ? [fileUri] : [fileUri, placeholderUri]);
            expect(reads).toEqual([fileUri]);
        } finally {
            gate.resolve(exists);
            await operation.result;
        }
    });

    it('catches a rejected real-file existence lookup and falls back to the actual read', async () => {
        const folder = pathFolder();
        folder.files.set(fileUri, new TextEncoder().encode(JSON.stringify(data)));
        const entered = deferred<void>();
        const gate = deferred<boolean>();
        const lookups: string[] = [];
        const { host } = fakeHost({ os: () => 'ios', path: {
            ...folder.port,
            exists: (uri) => { lookups.push(uri); entered.resolve(undefined); return gate.promise; },
        } });
        const operation = observe(createMobileFileSync(host).readSyncFile(fileUri));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            gate.reject(new Error('Existence lookup unavailable'));
            expect(await operation.result).toMatchObject({ state: 'fulfilled', value: data });
            expect(lookups).toEqual([fileUri]);
        } finally {
            gate.resolve(false);
            await operation.result;
        }
    });

    it.each(['present', 'absent', 'rejected'])('awaits the %s placeholder lookup inside the eviction catch', async (outcome) => {
        const folder = pathFolder();
        const backup: AppData = { ...data, settings: { theme: 'dark' } };
        folder.files.set(fileUri, new TextEncoder().encode(JSON.stringify(data)));
        folder.files.set(`${PATH_DIR}/data.json.bak`, new TextEncoder().encode(JSON.stringify(backup)));
        const entered = deferred<void>();
        const gate = deferred<boolean>();
        const lookups: string[] = [];
        const reads: string[] = [];
        const { host } = fakeHost({ os: () => 'ios', path: {
            ...folder.port,
            exists: (uri) => {
                lookups.push(uri);
                if (uri === fileUri) return false;
                entered.resolve(undefined);
                return gate.promise;
            },
            readText: async (uri) => { reads.push(uri); return folder.port.readText(uri); },
        } });
        const operation = observe(createMobileFileSync(host).readSyncFile(fileUri));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            expect(reads).toEqual([]);
            expect(lookups).toEqual([fileUri, placeholderUri]);
            if (outcome === 'rejected') gate.reject(new Error('Placeholder lookup unavailable'));
            else gate.resolve(outcome === 'present');
            const result = await operation.result;
            expect(result.state).toBe('fulfilled');
            if (result.state === 'fulfilled') expect(result.value?.settings).toEqual(outcome === 'present' ? backup.settings : data.settings);
            expect(reads).toEqual([outcome === 'present' ? `${PATH_DIR}/data.json.bak` : fileUri]);
        } finally {
            gate.resolve(false);
            await operation.result;
        }
    });

    it.each(['completed', 'rejected'])('keeps a create-only write pending until its payload is %s', async (outcome) => {
        const folder = pathFolder();
        const payload = new Uint8Array([1, 2, 3]);
        const failure = new Error('Payload write unavailable');
        const entered = deferred<void>();
        const gate = deferred<void>();
        const deleted: string[] = [];
        const { host } = fakeHost({ path: {
            ...folder.port,
            writeCreated: async (uri, bytes) => {
                entered.resolve(undefined);
                await gate.promise;
                folder.port.writeCreated(uri, bytes);
            },
            delete: async (uri) => { deleted.push(uri); await folder.port.delete(uri); },
        } });
        const operation = observe(createMobileFileSync(host).writeSyncArtifactBytes(fileUri, payload, { createOnly: true }));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            expect(folder.files.get(fileUri)).toEqual(new Uint8Array(0));
            if (outcome === 'rejected') gate.reject(failure);
            else gate.resolve(undefined);
            expect(await operation.result).toEqual(outcome === 'rejected'
                ? { state: 'rejected', reason: failure }
                : { state: 'fulfilled', value: undefined });
            expect(folder.files.get(fileUri)).toEqual(outcome === 'rejected' ? new Uint8Array(0) : payload);
            expect(deleted).toEqual([]);
        } finally {
            gate.resolve(undefined);
            await operation.result;
        }
    });

    it('keeps a pending rename out of the URI cache and waits before replacement or cleanup', async () => {
        const folder = pathFolder();
        const backupUri = `${PATH_DIR}/data.json.bak`;
        const original = new Uint8Array([1, 2]);
        const replacement = new Uint8Array([3, 4]);
        folder.files.set(backupUri, original);
        const entered = deferred<void>();
        const gate = deferred<void>();
        let renamedName = '';
        const mutations: string[] = [];
        const { host, logged, all } = fakeHost({ path: {
            ...folder.port,
            rename: async (uri, name) => {
                renamedName = name;
                entered.resolve(undefined);
                await gate.promise;
                mutations.push('renamed');
                return folder.port.rename(uri, name);
            },
            createExclusive: async (uri) => { mutations.push('created'); return folder.port.createExclusive(uri); },
            writeBytes: async (uri, bytes) => { mutations.push('written'); await folder.port.writeBytes(uri, bytes); },
            delete: async (uri) => { mutations.push('deleted'); await folder.port.delete(uri); },
        } });
        const remote = await createMobileFileSync(host).createFileSyncEncryptionRemotePort(fileUri);
        if (!remote) throw new Error('Expected path remote');
        const operation = observe(remote.rotateBackup('data.json.bak', replacement));
        const markers = () => logged.filter((entry) => JSON.stringify(entry.context).includes('v1.3.9/file-sync-path-await'));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            expect(mutations).toEqual([]);
            const unseen = observe(remote.read(renamedName));
            await nextTurn();
            expect(unseen.settled).toBe(true);
            expect(await unseen.result).toEqual({ state: 'fulfilled', value: { bytes: null, version: null } });
            expect(markers()).toEqual([]);
            expect(folder.files.get(backupUri)).toEqual(original);
            gate.resolve(undefined);
            expect(await operation.result).toEqual({ state: 'fulfilled', value: undefined });
            expect(folder.files.get(backupUri)).toEqual(replacement);
            expect([...folder.files.keys()]).toEqual([backupUri]);
            expect(mutations).toEqual(['renamed', 'created', 'written', 'deleted']);
            expect(markers()).toEqual([{ level: 'info', message: 'File Sync path rename completed', context: {
                scope: 'sync', extra: { releaseCheck: 'v1.3.9/file-sync-path-await', operation: 'rename', outcome: 'completed' },
            } }]);
            expect(all()).not.toContain(PRIVATE);
        } finally {
            gate.resolve(undefined);
            await operation.result;
        }
    });

    it.each([false, true])('handles rejected rename before cache mutation (peer conflict: %s)', async (peerConflict) => {
        const folder = pathFolder();
        const backupUri = `${PATH_DIR}/data.json.bak`;
        const original = new Uint8Array([1, 2]);
        const peer = new Uint8Array([8, 9]);
        folder.files.set(backupUri, original);
        const entered = deferred<void>();
        const gate = deferred<void>();
        const failure = new Error('Rename unavailable');
        let renamedName = '';
        const mutations: string[] = [];
        const { host, logged } = fakeHost({ path: {
            ...folder.port,
            rename: async (_uri, name) => { renamedName = name; entered.resolve(undefined); await gate.promise; throw failure; },
            createExclusive: async (uri) => { mutations.push('created'); return folder.port.createExclusive(uri); },
            delete: async (uri) => { mutations.push('deleted'); await folder.port.delete(uri); },
        } });
        const remote = await createMobileFileSync(host).createFileSyncEncryptionRemotePort(fileUri);
        if (!remote) throw new Error('Expected path remote');
        const operation = observe(remote.rotateBackup('data.json.bak', new Uint8Array([3, 4])));
        try {
            await entered.promise;
            await nextTurn();
            expect(operation.settled).toBe(false);
            if (peerConflict) folder.files.set(`${PATH_DIR}/${renamedName}`, peer);
            gate.reject(failure);
            const result = await operation.result;
            expect(result.state).toBe('rejected');
            if (result.state === 'rejected') {
                if (peerConflict) expect(result.reason).toBeInstanceOf(SyncEncryptionRemoteConflictError);
                else expect(result.reason).toBe(failure);
            }
            const retained = await observe(remote.read(renamedName)).result;
            expect(retained.state).toBe('fulfilled');
            if (retained.state === 'fulfilled') expect(retained.value.bytes).toEqual(peerConflict ? peer : null);
            expect(folder.files.get(backupUri)).toEqual(original);
            expect(mutations).toEqual([]);
            expect(logged.some((entry) => JSON.stringify(entry.context).includes('v1.3.9/file-sync-path-await'))).toBe(false);
        } finally {
            gate.resolve(undefined);
            await operation.result;
        }
    });
});

describe('File Sync log contexts', () => {
    it('never carry the sync file path when the file is missing', async () => {
        const { host, logged, contexts } = fakeHost({ path: { readText: async () => null } as never });
        const fileUri = `${PATH_DIR}/data.json`;

        await expect(createMobileFileSync(host).readFileText(fileUri)).resolves.toBeNull();

        expect(logged).toHaveLength(1);
        expect(contexts()).not.toContain(PRIVATE);
    });

    it('log a failed iOS bookmark read by its error name, not its text', async () => {
        const folder = pathFolder();
        folder.files.set(`${PATH_DIR}/data.json`, new TextEncoder().encode(JSON.stringify(data)));
        const { host, logged, contexts } = fakeHost({
            os: () => 'ios',
            path: folder.port,
            bookmarks: { supported: () => true, readText: async () => { throw new Error(`The file "${PATH_DIR}/data.json" could not be opened`); } },
        });

        await expect(createMobileFileSync(host).readSyncFile(`${PATH_DIR}/data.json`, { bookmark: 'bookmark-1' })).resolves.toMatchObject({ tasks: [] });

        expect(logged.find((entry) => entry.message.startsWith('Bookmarked sync read failed'))?.context).toEqual({ scope: 'sync', extra: { error: 'Error' } });
        expect(contexts()).not.toContain(PRIVATE);
    });

    it('log a skipped backup rotation by its error name, not its text', async () => {
        const folder = pathFolder((name) => name === 'data.json.bak');
        folder.files.set(`${PATH_DIR}/data.json`, new TextEncoder().encode(JSON.stringify(data)));
        const { host, logged, contexts } = fakeHost({ path: folder.port });
        const sync = createMobileFileSync(host);
        const remote = await sync.readSyncFileVersioned(`${PATH_DIR}/data.json`);

        await sync.writeSyncFile(`${PATH_DIR}/data.json`, { ...data, settings: { weekStart: 'monday' } }, { expectedFingerprint: remote.fingerprint });

        expect(logged.find((entry) => entry.message.startsWith('File Sync backup rotation skipped'))?.context).toEqual({ scope: 'sync', extra: { error: 'EACCES' } });
        expect(contexts()).not.toContain(PRIVATE);
    });

    it('log a failed rename repair of a decorated SAF name by its error code, not its text', async () => {
        const documents = new Map<string, { name: string; bytes: Uint8Array }>();
        const row = (uri: string) => ({ uri, name: documents.get(uri)!.name, size: documents.get(uri)!.bytes.length });
        const { host, logged, contexts } = fakeHost({
            saf: {
                listChildren: async () => [...documents.keys()].map(row),
                stat: async (uri: string) => (documents.has(uri) ? row(uri) : null),
                readBytes: async (uri: string) => ({ bytes: documents.get(uri)!.bytes, lengthVerified: true }),
                writeBytes: async (uri: string, bytes: Uint8Array) => { documents.get(uri)!.bytes = bytes; },
                writeText: async () => undefined,

                createFile: async (_dir: string, name: string) => {
                    const shown = name.startsWith('.mindwtr-et-s-') ? `${name}.bin` : name;
                    documents.set(safChild(shown), { name: shown, bytes: new Uint8Array(0) });
                    return safChild(shown);
                },
                delete: async (uri: string) => { documents.delete(uri); },
                rename: async (uri: string) => { throw new Error(`SAF_DOCUMENT_UNAVAILABLE: rename of ${uri} refused`); },
            } as never,
        });

        await expect(createMobileFileSync(host).writeSyncFile(safChild('data.json'), data, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT }))
            .rejects.toThrow('another writer');

        expect(logged.find((entry) => entry.message.endsWith('repair failed'))?.context)
            .toMatchObject({ scope: 'sync', extra: { error: 'SAF_DOCUMENT_UNAVAILABLE' } });
        expect(contexts()).not.toContain(PRIVATE);
    });

    it('log a failed sync file read by its error code, in the error line\'s message and stack too', async () => {
        const folder = pathFolder();
        folder.port.readText = async (uri: string) => { throw new Error(`EACCES: permission denied, open '${uri}'`); };
        folder.port.readBytes = async (uri: string) => { throw new Error(`EACCES: permission denied, open '${uri}'`); };
        const { host, logged, all } = fakeHost({ path: folder.port });

        await expect(createMobileFileSync(host).readSyncFile(`${PATH_DIR}/data.json`)).rejects.toThrow(PRIVATE);

        expect(logged.find((entry) => entry.level === 'error')?.message.split('\n')[0]).toBe('EACCES');
        expect(all()).not.toContain(PRIVATE);
    });

    it('log a failed sync file write by its error code, in the error line\'s message and stack too', async () => {
        const folder = pathFolder((name) => name.startsWith('.mindwtr-et-s-'));
        const { host, logged, all } = fakeHost({ path: folder.port });

        await expect(createMobileFileSync(host).writeSyncFile(`${PATH_DIR}/data.json`, data, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT }))
            .rejects.toThrow(PRIVATE);

        expect(logged.find((entry) => entry.level === 'error')?.message.split('\n')[0]).toBe('EACCES');
        expect(all()).not.toContain(PRIVATE);
    });
});

describe('fileSyncErrorCode', () => {
    it('answers a leading code, else a plain error name, never text', () => {
        expect(fileSyncErrorCode(new Error('SAF_DOCUMENT_UNAVAILABLE: content://x/private'))).toBe('SAF_DOCUMENT_UNAVAILABLE');
        expect(fileSyncErrorCode(new TypeError(`bad ${PATH_DIR}`))).toBe('TypeError');
        const named = new Error('x');
        named.name = `${PATH_DIR}/data.json`;
        expect(fileSyncErrorCode(named)).toBe('Error');
        expect(fileSyncErrorCode(`${PATH_DIR}/data.json`)).toBe('string');
    });
});


type ObservedCall = { operation: string; uri: string; bytes?: Uint8Array; destination?: string };
const observedFolder = (initial: Record<string, Uint8Array> = {}) => {
    const folder = pathFolder();
    for (const [name, bytes] of Object.entries(initial)) folder.files.set(`${PATH_DIR}/${name}`, new Uint8Array(bytes));
    const owned = new Map<string, { state: 'unfinished' | 'created' | 'quarantine'; generation: Uint8Array }>();
    const calls: ObservedCall[] = [];
    let before: (call: ObservedCall) => void | Promise<void> = () => undefined;
    let after: (call: ObservedCall) => void | Promise<void> = () => undefined;
    let closed = false, lateCalls = 0, legacyCalls = 0;
    const same = (left: Uint8Array | undefined, right: Uint8Array) => left?.length === right.length && left.every((byte, index) => byte === right[index]);
    const leaf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
    const child = (uri: string) => {
        if (!uri.startsWith(`${PATH_DIR}/`) || uri.slice(PATH_DIR.length + 1).includes('/') || ['.', '..', ''].includes(leaf(uri))) throw new Error('Outside selected root');
    };
    const io = async <T>(call: ObservedCall, work: () => T): Promise<T> => {
        calls.push(call);
        if (closed) { lateCalls += 1; throw new Error('Owner already closed'); }
        try {
            await before(call);
            const result = work();
            await after(call);
            return result;
        } catch (error) { closed = true; owned.clear(); throw error; }
    };
    const generic = () => { legacyCalls += 1; throw new Error('Generic mutation is unsupported'); };
    const publication: MobileFileSyncObservedPublication = {
        createExclusive: uri => io<'created' | 'exists'>({ operation: 'create', uri }, () => {
            child(uri);
            if (folder.files.has(uri)) return 'exists';
            const generation = new Uint8Array(0); folder.files.set(uri, generation);
            owned.set(uri, { state: 'unfinished', generation }); return 'created';
        }),
        writeCreated: (uri, bytes) => io({ operation: 'write', uri, bytes: new Uint8Array(bytes) }, () => {
            const entry = owned.get(uri);
            if (!entry || entry.state !== 'unfinished' || folder.files.get(uri) !== entry.generation) throw new Error('Unowned creation');
            const generation = new Uint8Array(bytes); folder.files.set(uri, generation);
            owned.set(uri, { state: 'created', generation });
        }),
        renameObserved: (uri, name, bytes) => io({ operation: 'rename', uri, bytes: new Uint8Array(bytes), destination: `${PATH_DIR}/${name}` }, () => {
            child(uri); const destination = `${PATH_DIR}/${name}`; child(destination);
            if (!name.startsWith('.mindwtr-et-q-') || !same(folder.files.get(uri), bytes) || folder.files.has(destination)) throw new Error('Generation or destination changed');
            if (owned.get(uri)?.state === 'unfinished') throw new Error('Unfinished creation');
            const generation = folder.files.get(uri); if (!generation) throw new Error('Missing observed body');
            folder.files.set(destination, generation); folder.files.delete(uri); owned.delete(uri);
            owned.set(destination, { state: 'quarantine', generation }); return destination;
        }),
        deleteOwned: (uri, bytes) => io({ operation: 'delete', uri, bytes: new Uint8Array(bytes) }, () => {
            child(uri); const entry = owned.get(uri), name = leaf(uri);
            if (!entry || folder.files.get(uri) !== entry.generation || !same(entry.generation, bytes)
                || !((entry.state === 'created' && name.startsWith('.mindwtr-et-s-')) || (entry.state === 'quarantine' && name.startsWith('.mindwtr-et-q-')))) throw new Error('Unowned deletion');
            folder.files.delete(uri); owned.delete(uri);
        }),
    };
    const path: MobileFileSyncFullHost['path'] = {
        exists: uri => io({ operation: 'exists', uri }, () => uri.replace(/\/+$/, '') === PATH_DIR || folder.files.has(uri)),
        info: uri => io({ operation: 'info', uri }, () => ({ exists: uri.replace(/\/+$/, '') === PATH_DIR || folder.files.has(uri), size: folder.files.get(uri)?.length })),
        list: uri => io({ operation: 'list', uri }, () => {
            if (uri.replace(/\/+$/, '') !== PATH_DIR) throw new Error('Outside selected root');
            return [...folder.files.keys()].map(leaf);
        }),
        readBytes: uri => io({ operation: 'read', uri }, () => { child(uri); const bytes = folder.files.get(uri); return bytes === undefined ? null : new Uint8Array(bytes); }),
        readText: uri => io({ operation: 'text', uri }, () => { child(uri); const bytes = folder.files.get(uri); return bytes === undefined ? null : new TextDecoder().decode(bytes); }),
        writeBytes: generic, createExclusive: generic, writeCreated: generic, delete: generic, rename: generic,
        observedPublication: publication,
    };
    const result = fakeHost({ os: () => 'ios', path });
    return { ...result, files: folder.files, calls, publication,
        before: (hook: typeof before) => { before = hook; }, after: (hook: typeof after) => { after = hook; },
        counters: () => ({ closed, lateCalls, legacyCalls }),
        mutations: () => calls.filter(call => ['create', 'write', 'rename', 'delete'].includes(call.operation)),
        completions: () => result.logged.filter(entry => entry.message === 'File Sync observed path publication completed'),
    };
};

const observedBytes = (weekStart: 'monday' | 'sunday') => new TextEncoder().encode(JSON.stringify({ ...data, settings: { weekStart } }, null, 2));

describe('observed publication capability', () => {
    const uri = `${PATH_DIR}/data.json`, backup = `${PATH_DIR}/data.json.bak`;
    const current = observedBytes('sunday'), peer = observedBytes('monday'), next: AppData = { ...data, settings: { theme: 'dark' } };
    const payload = new TextEncoder().encode(JSON.stringify(next, null, 2));
    const oldBackup = new Uint8Array([7, 8, 9]), sentinel = new Uint8Array([0, 255, 3]);
    const remoteFor = async (folder: ReturnType<typeof observedFolder>) => {
        const remote = await createMobileFileSync(folder.host).createFileSyncEncryptionRemotePort(uri);
        if (!remote) throw new Error('Expected observed remote'); return remote;
    };
    const write = async (folder: ReturnType<typeof observedFolder>) => {
        const sync = createMobileFileSync(folder.host), read = await sync.readSyncFileVersioned(uri);
        return sync.writeSyncFile(uri, next, { expectedFingerprint: read.fingerprint });
    };

    it.each([oldBackup, new Uint8Array(0)])('forwards complete old generations and owned cleanup without generic mutations (%j)', async old => {
        const folder = observedFolder({ 'data.json': current, 'data.json.bak': old, sentinel });
        const result = await observe(write(folder)).result;
        expect(folder.calls.find(call => call.operation === 'rename')?.bytes).toEqual(old);
        expect(folder.counters().legacyCalls).toBe(0);
        expect(result).toEqual({ state: 'fulfilled', value: undefined });
        expect(folder.files.get(uri)).toEqual(payload); expect(folder.files.get(backup)).toEqual(current);
        expect(folder.files.get(`${PATH_DIR}/sentinel`)).toEqual(sentinel);
        expect([...folder.files.keys()].sort()).toEqual([uri, backup, `${PATH_DIR}/sentinel`].sort());
        const renames = folder.calls.filter(call => call.operation === 'rename');
        expect(renames.map(call => call.bytes)).toEqual([old, current]);
        const first = renames[0]; if (!first) throw new Error('Expected backup quarantine');
        expect(folder.calls.findIndex(call => call.operation === 'read' && call.uri === backup)).toBeLessThan(folder.calls.indexOf(first));
        expect(folder.calls.filter(call => call.operation === 'delete').map(call => call.bytes)).toEqual([old, payload, current]);
        expect(folder.counters()).toEqual({ closed: false, lateCalls: 0, legacyCalls: 0 });
        expect(folder.completions()).toHaveLength(1);
        expect(folder.completions()[0]?.context).toEqual({ scope: 'sync', extra: { releaseCheck: 'v1.3.9/file-sync-observed-publication', operation: 'write', outcome: 'completed' } });
    });

    it.each([null, {}, { createExclusive: async (): Promise<'created'> => 'created' }, { createExclusive: async (): Promise<'created'> => 'created', writeCreated: async () => undefined, renameObserved: async () => uri }])('rejects incomplete capability before IO (%j)', value => {
        const folder = observedFolder(); Object.defineProperty(folder.host.path, 'observedPublication', { value });
        expect(() => createMobileFileSync(folder.host)).toThrow('complete observed publication capability');
        expect(folder.calls).toEqual([]); expect(folder.counters().legacyCalls).toBe(0);
    });

    it('uses exclusive canonical creation for an absent version', async () => {
        const folder = observedFolder();
        await createMobileFileSync(folder.host).writeSyncFile(uri, next, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT });
        expect(folder.files.get(uri)).toEqual(payload); expect(folder.calls.some(call => call.operation === 'rename')).toBe(false);
        expect(folder.counters().legacyCalls).toBe(0);
    });

    it('preserves a peer created just before canonical install', async () => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        folder.before(call => { if (call.operation === 'create' && call.uri === uri) folder.files.set(uri, peer); });
        await expect(remote.write('data.json', payload, read.version)).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
        expect(folder.files.get(uri)).toEqual(peer);
        expect(folder.calls.filter(call => call.operation === 'delete')).toEqual([]);
        expect([...folder.files.keys()].some(name => name.includes('.mindwtr-et-q-'))).toBe(true);
    });

    it('refuses a stale fingerprint before any mutation', async () => {
        const folder = observedFolder({ 'data.json': current });
        await expect(createMobileFileSync(folder.host).writeSyncFile(uri, next, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT })).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
        expect(folder.mutations()).toEqual([]); expect(folder.files.get(uri)).toEqual(current);
    });

    it('forwards the observed canonical generation even when a same-length peer arrives after staging', async () => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        expect(current.length).toBe(peer.length);
        folder.before(call => { if (call.operation === 'rename' && call.uri === uri) folder.files.set(uri, peer); });
        await expect(remote.write('data.json', payload, read.version)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.calls.find(call => call.operation === 'rename')?.bytes).toEqual(current);
        expect(folder.files.get(uri)).toEqual(peer); expect(folder.counters().lateCalls).toBe(0);
    });

    it('does not turn a terminal metadata rejection into absence', async () => {
        const folder = observedFolder(), remote = await remoteFor(folder);
        folder.before(call => { if (call.operation === 'info' && call.uri === uri) throw new Error(`EIO: ${uri}`); });
        await expect(remote.read('data.json')).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.counters().lateCalls).toBe(0); expect(folder.mutations()).toEqual([]);
    });

    it.each([{}, { exists: undefined }].flatMap(metadata => [
        { metadata, operation: 'read' }, { metadata, operation: 'write' },
    ]))('refuses unknown metadata before $operation or later IO ($metadata)', async ({ metadata, operation }) => {
        const folder = observedFolder({ sentinel }), remote = await remoteFor(folder);
        const info = folder.host.path.info; let returnedAt = 0;
        folder.host.path.info = async target => {
            await info(target); returnedAt = folder.calls.length; return metadata;
        };
        const result = await observe<unknown>(operation === 'read'
            ? remote.read('data.json') : remote.write('data.json', payload, null)).result;
        expect(returnedAt).toBeGreaterThan(0);
        expect(folder.calls).toHaveLength(returnedAt);
        expect(folder.mutations()).toEqual([]);
        expect([...folder.files.entries()]).toEqual([[`${PATH_DIR}/sentinel`, sentinel]]);
        expect(result.state).toBe('rejected');
        if (result.state === 'rejected') expect(result.reason).toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.counters()).toEqual({ closed: false, lateCalls: 0, legacyCalls: 0 });
        expect(folder.completions()).toEqual([]);
    });

    it('preserves legacy RN unknown-metadata absence and publication behavior', async () => {
        const folder = pathFolder();
        const { host } = fakeHost({ os: () => 'ios', path: { ...folder.port,
            info: async target => folder.files.has(target) ? { exists: true, size: folder.files.get(target)?.length } : {},
        } });
        const remote = await createMobileFileSync(host).createFileSyncEncryptionRemotePort(uri);
        if (!remote) throw new Error('Expected legacy remote');
        expect(await remote.read('data.json')).toEqual({ bytes: null, version: null });
        await remote.write('data.json', payload, null);
        expect(folder.files.get(uri)).toEqual(payload);
    });

    it.each(['exists', 'text'])('does not retry or fall back after terminal %s failure', async operation => {
        const folder = observedFolder({ 'data.json': current });
        folder.before(call => { if (call.operation === operation) throw new Error(`EIO: ${uri}`); });
        await expect(createMobileFileSync(folder.host).readSyncFile(uri)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.counters().lateCalls).toBe(0);
    });

    it.each(['read-before', 'rename-before', 'rename-after', 'write-before', 'write-after', 'readback', 'delete-before', 'delete-after'])('terminal backup %s failure cannot continue canonical publication', async mode => {
        const folder = observedFolder({ 'data.json': current, 'data.json.bak': oldBackup, sentinel });
        let installed = false, fired = false;
        const fault = (call: ObservedCall, after: boolean) => {
            if (after && call.operation === 'write' && call.uri === backup) installed = true;
            const trigger = (mode === 'read-before' && !after && call.operation === 'read' && call.uri === backup)
                || (mode.startsWith('rename-') && call.operation === 'rename' && call.uri === backup && after === mode.endsWith('after'))
                || (mode.startsWith('write-') && call.operation === 'write' && call.uri === backup && after === mode.endsWith('after'))
                || (mode === 'readback' && !after && installed && call.operation === 'read' && call.uri === backup)
                || (mode.startsWith('delete-') && call.operation === 'delete' && after === mode.endsWith('after'));
            if (trigger && !fired) { fired = true; throw new Error(`EIO: ${backup}`); }
        };
        folder.before(call => fault(call, false)); folder.after(call => fault(call, true));
        await expect(write(folder)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(fired).toBe(true); expect(folder.files.get(uri)).toEqual(current);
        expect(folder.files.get(`${PATH_DIR}/sentinel`)).toEqual(sentinel);
        expect(folder.counters().lateCalls).toBe(0); expect(folder.counters().legacyCalls).toBe(0);
        expect(folder.completions()).toEqual([]);
        expect(folder.logged.some(entry => entry.message.startsWith('File Sync backup rotation skipped'))).toBe(false);
        expect(folder.all()).not.toContain(PRIVATE);
    });

    it('keeps a normal backup create collision best effort while preserving peer backup and retained bytes', async () => {
        const folder = observedFolder({ 'data.json': current, 'data.json.bak': oldBackup });
        folder.before(call => { if (call.operation === 'create' && call.uri === backup) folder.files.set(backup, peer); });
        await write(folder);
        expect(folder.files.get(uri)).toEqual(payload); expect(folder.files.get(backup)).toEqual(peer);
        expect([...folder.files.entries()].some(([name, bytes]) => name.includes('.mindwtr-et-q-') && bytes.every((byte, i) => byte === oldBackup[i]) && bytes.length === oldBackup.length)).toBe(true);
        expect(folder.counters().closed).toBe(false);
        expect(folder.logged.some(entry => entry.message.startsWith('File Sync backup rotation skipped'))).toBe(true);
        expect(folder.completions()).toHaveLength(1);
    });

    it.each(['write', 'rename', 'verify', 'delete'].flatMap(boundary => [{ boundary, rejected: false }, { boundary, rejected: true }]))('awaits entered $boundary with rejection=$rejected before advancing publication', async ({ boundary, rejected }) => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        const entered = deferred<void>(), release = deferred<void>(); let canonicalWritten = false, fired = false;
        folder.after(call => { if (call.operation === 'write' && call.uri === uri) canonicalWritten = true; });
        folder.before(async call => {
            const matches = boundary === 'write' ? call.operation === 'write' && call.uri.includes('.mindwtr-et-s-')
                : boundary === 'rename' ? call.operation === 'rename'
                    : boundary === 'verify' ? call.operation === 'read' && call.uri === uri && canonicalWritten : call.operation === 'delete';
            if (matches && !fired) { fired = true; entered.resolve(undefined); await release.promise; }
        });
        const operation = observe(remote.write('data.json', payload, read.version));
        try {
            await entered.promise; await nextTurn(); expect(operation.settled).toBe(false);
            expect(folder.calls.filter(call => call.operation === 'delete')).toHaveLength(boundary === 'delete' ? 1 : 0);
            if (boundary === 'write' || boundary === 'rename') expect(folder.files.get(uri)).toEqual(current);
            if (rejected) {
                release.reject(new Error('Entered owner operation failed'));
                const result = await operation.result;
                expect(result.state).toBe('rejected');
                if (result.state === 'rejected') expect(result.reason).toBeInstanceOf(FileSyncPathOwnerTerminatedError);
                expect(folder.files.get(uri)).toEqual(boundary === 'write' || boundary === 'rename' ? current : payload);
                expect([...folder.files.keys()].some(name => name.includes('.mindwtr-et-s-'))).toBe(true);
                expect(folder.counters().lateCalls).toBe(0);
            } else {
                release.resolve(undefined); expect(await operation.result).toMatchObject({ state: 'fulfilled', value: { bytes: payload } });
                expect(folder.files.get(uri)).toEqual(payload);
            }
            expect(folder.counters().legacyCalls).toBe(0);
        } finally { release.resolve(undefined); await operation.result; }
    });

    it('forwards old backup bytes to owned retirement after verifying replacement', async () => {
        const folder = observedFolder({ 'data.json': current, 'data.json.bak': oldBackup });
        const result = await observe(write(folder)).result;
        expect(folder.calls.find(call => call.operation === 'delete')?.bytes).toEqual(oldBackup);
        expect(result).toEqual({ state: 'fulfilled', value: undefined });
    });

    it('refuses a same-length canonical verification mismatch before owned cleanup', async () => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        let installed = false;
        const changed = new Uint8Array(payload); changed[changed.findIndex(byte => byte === 'd'.charCodeAt(0))] ^= 1;
        folder.after(call => { if (call.operation === 'write' && call.uri === uri) installed = true; });
        folder.before(call => { if (installed && call.operation === 'read' && call.uri === uri) folder.files.set(uri, changed); });
        const result = await observe(remote.write('data.json', payload, read.version)).result;
        expect(result.state).toBe('rejected');
        if (result.state === 'rejected') expect(result.reason).toBeInstanceOf(SyncEncryptionRemoteConflictError);
        expect(folder.calls.filter(call => call.operation === 'delete')).toEqual([]);
        expect(folder.files.get(uri)).toEqual(changed);
        expect([...folder.files.keys()].some(name => name.includes('.mindwtr-et-q-'))).toBe(true);
    });

    it('refuses generic native writes and deletion without an owned-byte observation', async () => {
        const folder = observedFolder({ 'data.json': current }), sync = createMobileFileSync(folder.host);
        await expect(sync.writeSyncArtifactBytes(uri, payload)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        await expect(sync.deleteSyncArtifact(uri)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.files.get(uri)).toEqual(current); expect(folder.calls).toEqual([]);
        expect(folder.counters().legacyCalls).toBe(0);
    });

    it('refuses a created-only destination outside the selected root', async () => {
        const folder = observedFolder(), sync = createMobileFileSync(folder.host);
        await expect(sync.writeSyncArtifactBytes('file:///outside/data.json', payload, { createOnly: true })).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(folder.files.size).toBe(0); expect(folder.counters().legacyCalls).toBe(0);
    });

    it('retains a changed quarantine when owned cleanup rejects its old generation', async () => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        let changed: string | undefined;
        folder.before(call => {
            if (call.operation === 'delete' && call.uri.includes('.mindwtr-et-q-')) {
                changed = call.uri; folder.files.set(call.uri, peer);
            }
        });
        await expect(remote.write('data.json', payload, read.version)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(changed).toBeDefined();
        if (changed) expect(folder.files.get(changed)).toEqual(peer);
        expect(folder.files.get(uri)).toEqual(payload); expect(folder.counters().lateCalls).toBe(0);
        expect(folder.completions()).toEqual([]);
    });

    it.each([false, true])('quarantines versioned remove and preserves a recreated canonical=%s', async recreate => {
        const folder = observedFolder({ 'data.json': current }), remote = await remoteFor(folder), read = await remote.read('data.json');
        if (read.version === null) throw new Error('Expected observed generation');
        let moved = false;
        folder.after(call => { if (call.operation === 'rename') moved = true; });
        folder.before(call => { if (recreate && moved && call.operation === 'info' && call.uri === uri) folder.files.set(uri, peer); });
        if (recreate) {
            await expect(remote.remove('data.json', read.version)).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
            expect(folder.files.get(uri)).toEqual(peer); expect(folder.calls.some(call => call.operation === 'delete')).toBe(false);
        } else {
            await remote.remove('data.json', read.version); expect(folder.files.has(uri)).toBe(false);
            expect(folder.calls.filter(call => call.operation === 'delete').map(call => call.bytes)).toEqual([current]);
        }
        expect(folder.counters().legacyCalls).toBe(0);
    });
});


describe('File Sync encryption enable order', () => {


    it('seals attachments/ one entry at a time in compareSyncTransitionEntryNames order, whatever the case or punctuation', async () => {
        const folder = pathFolder();
        const encode = (text: string) => new TextEncoder().encode(text);
        folder.files.set(`${PATH_DIR}/data.json`, encode(JSON.stringify(data)));
        const names = ['b.txt', 'B.txt', 'a-1.txt', 'a.1.txt', 'A.txt', '10.txt', '9.txt', '_x.txt', 'Z-z.txt'];
        for (const name of names) folder.files.set(`${PATH_DIR}/attachments/${name}`, encode(name));

        folder.port.list = async (dir: string) => [...new Set([...folder.files.keys()]
            .filter((key) => key.startsWith(dir)).map((key) => key.slice(dir.length).split('/')[0]))];
        const sealed: string[] = [];
        const rename = folder.port.rename;
        folder.port.rename = (uri: string, name: string) => {
            const leaf = uri.slice(uri.lastIndexOf('/') + 1);
            if (uri.startsWith(`${PATH_DIR}/attachments/`) && names.includes(leaf)) sealed.push(leaf);
            return rename(uri, name);
        };
        const { host } = fakeHost({ path: folder.port, crypto: defaultSyncCryptoPrimitives });
        const remote = await createMobileFileSync(host).createFileSyncEncryptionRemotePort(`${PATH_DIR}/data.json`);
        let state: SyncEncryptionLocalState | null = null;
        let key: Uint8Array | null = null;
        await runEnableSyncEncryptionOverRemote('correct horse', remote!, {
            getKey: async () => key, setKey: async (next) => { key = next; }, clearKey: async () => { key = null; },
        }, { read: () => state, write: (next) => { state = next; } }, undefined, defaultSyncCryptoPrimitives, { mKib: 8, t: 1, p: 1 });

        expect(sealed).toEqual([...names].sort(compareSyncTransitionEntryNames));
        expect(sealed).toEqual(['10.txt', '9.txt', 'A.txt', 'B.txt', 'Z-z.txt', '_x.txt', 'a-1.txt', 'a.1.txt', 'b.txt']);
    });
});


const safFolder = (options: { create?: 'decorate' | 'duplicate' | 'return-existing'; lag?: boolean; pathIds?: boolean } = {}) => {
    const root = `${SAF_TREE}/document/primary%3A${PRIVATE}`;
    const docs = new Map<string, { parent: string; name: string; bytes: Uint8Array | null; hidden: number }>();
    const calls = { list: 0, rows: 0, read: 0 };
    let sequence = 0;
    let onCall: (op: 'create' | 'write' | 'read', name: string) => void = () => undefined;
    const add = (parent: string, name: string, bytes: Uint8Array | null, hidden = 0) => {
        sequence += 1;
        const uri = `${parent}%2F${encodeURIComponent(name)}${options.pathIds ? '' : `~${sequence}`}`;
        docs.set(uri, { parent, name, bytes, hidden });
        return uri;
    };
    const row = (uri: string) => ({ uri, name: docs.get(uri)!.name, size: docs.get(uri)!.bytes?.length ?? null });
    const port = {
        listChildren: async (dir: string) => {
            const children = [...docs].filter(([, doc]) => doc.parent === dir && (doc.hidden === 0 || (doc.hidden -= 1, false)))
                .map(([uri]) => row(uri));
            calls.list += 1;
            calls.rows += children.length;
            return children;
        },
        stat: async (uri: string) => (docs.has(uri) ? row(uri) : null),
        readBytes: async (uri: string) => {
            calls.read += 1;
            const doc = docs.get(uri);
            onCall('read', doc?.name ?? '');
            if (!doc?.bytes) throw new Error('SAF_DOCUMENT_UNAVAILABLE');
            return { bytes: doc.bytes, lengthVerified: true };
        },
        writeBytes: async (uri: string, bytes: Uint8Array) => { onCall('write', docs.get(uri)!.name); docs.get(uri)!.bytes = bytes; },
        writeText: async () => undefined,
        createFile: async (dir: string, name: string) => {
            onCall('create', name);
            const existing = [...docs].find(([, doc]) => doc.parent === dir && doc.name === name);
            if (existing && options.create === 'return-existing') return existing[0];
            const taken = (candidate: string) => [...docs.values()].some((doc) => doc.parent === dir && doc.name === candidate);
            let shown = name;
            if (!options.create || options.create === 'decorate') for (let n = 1; taken(shown); n += 1) shown = `${name} (${n})`;
            return add(dir, shown, new Uint8Array(0), options.lag ? 1 : 0);
        },
        delete: async (uri: string) => { docs.delete(uri); },
        rename: async (uri: string, name: string) => {
            const doc = docs.get(uri)!;
            docs.delete(uri);
            return { uri: add(doc.parent, name, doc.bytes), name };
        },
    };
    const named = (parent: string) => [...docs.values()].filter((doc) => doc.parent === parent);
    return { root, docs, calls, port, add, named, peer: (next: typeof onCall) => { onCall = next; } };
};

const encodeText = (text: string) => new TextEncoder().encode(text);
const decodeText = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : '');
const memoryKeys = () => {
    let state: SyncEncryptionLocalState | null = null;
    let key: Uint8Array | null = null;
    return {
        keyCache: { getKey: async () => key, setKey: async (next: Uint8Array) => { key = next; }, clearKey: async () => { key = null; } },
        localState: { read: () => state, write: (next: SyncEncryptionLocalState | null) => { state = next; } },
    };
};
const CHEAP_KDF = { mKib: 8, t: 1, p: 1 };


const enableOver = async (folder: ReturnType<typeof safFolder>) => {
    folder.add(folder.root, 'data.json', encodeText(JSON.stringify(data)));
    const attachmentsDir = folder.add(folder.root, 'attachments', null);
    for (let i = 0; i < 3; i += 1) folder.add(attachmentsDir, `file-${i}.txt`, encodeText(`attachment ${i}`));
    const { host, logged } = fakeHost({ saf: folder.port as never, crypto: defaultSyncCryptoPrimitives });
    const remote = (await createMobileFileSync(host).createFileSyncEncryptionRemotePort(safChild('data.json')))!;
    const keys = memoryKeys();
    const outcome = await runEnableSyncEncryptionOverRemote('correct horse', remote, keys.keyCache, keys.localState, undefined,
        defaultSyncCryptoPrimitives, CHEAP_KDF).then(() => 'ok', (error: Error) => error.name);
    return { outcome, logged, keys, attachmentsDir };
};

describe('File Sync encryption transition guards kept while cutting its cost', () => {
    it('refuses a create-only write when a peer created the name after the inventory, on a provider that hands it back', async () => {
        const folder = safFolder({ create: 'return-existing' });
        let created = false;
        folder.peer((op, name) => {
            if (created || op !== 'write' || !name.startsWith('file-')) return;
            created = true;
            folder.add(folder.root, 'data.json.enc', encodeText('PEER-GENERATION'));
        });
        const { outcome } = await enableOver(folder);
        expect(outcome).toBe('SyncEncryptionRemoteConflictError');
        expect(folder.named(folder.root).filter((doc) => doc.name === 'data.json.enc').map((doc) => decodeText(doc.bytes)))
            .toEqual(['PEER-GENERATION']);
        expect(folder.named(folder.root).some((doc) => doc.name === 'data.json')).toBe(true);
    });

    it('refuses a document install when a peer added a second document under its name, on a provider that allows that', async () => {
        const folder = safFolder({ create: 'duplicate' });
        let duplicated = false;
        folder.peer((op, name) => {
            if (duplicated || op !== 'write' || name !== 'data.json.enc') return;
            duplicated = true;
            folder.add(folder.root, 'data.json.enc', encodeText('PEER-DUPLICATE'));
        });
        const { outcome } = await enableOver(folder);
        expect(outcome).toBe('SyncEncryptionRemoteConflictError');
        expect(folder.named(folder.root).some((doc) => doc.name === 'data.json')).toBe(true);
    });

    it('fails before moving an original aside when the provider does not list a new document yet', async () => {
        const folder = safFolder({ lag: true });
        folder.add(folder.root, 'data.json', encodeText(JSON.stringify(data)));
        const { host } = fakeHost({ saf: folder.port as never });
        const sync = createMobileFileSync(host);
        const current = await sync.readSyncFileVersioned(safChild('data.json'));
        await expect(sync.writeSyncFile(safChild('data.json'), { ...data, settings: { weekStart: 'monday' } },
            { expectedFingerprint: current.fingerprint })).rejects.toThrow('another writer');
        expect(folder.named(folder.root).filter((doc) => doc.name === 'data.json').map((doc) => decodeText(doc.bytes)))
            .toEqual([JSON.stringify(data)]);
    });

    for (const pathIds of [false, true]) {
        it(`refuses to move aside an attachment a peer replaced with a new document, on a provider proved to rename a taken name${pathIds ? ' and naming documents by path' : ''}`, async () => {
            const folder = safFolder({ pathIds });
            let replaced = false;
            folder.peer((op, name) => {
                if (replaced || op !== 'write' || !name.startsWith('.mindwtr-et-s-')) return;
                replaced = true;
                const [uri, doc] = [...folder.docs].find(([, entry]) => entry.name === 'file-0.txt')!;
                folder.docs.delete(uri);
                folder.add(doc.parent, 'file-0.txt', encodeText('PEER-REPLACEMENT'));
            });
            const { outcome } = await enableOver(folder);
            expect(outcome).toBe('SyncEncryptionRemoteConflictError');


            expect([...folder.docs.values()].filter((doc) => doc.name === 'file-0.txt').map((doc) => decodeText(doc.bytes)))
                .toEqual(['PEER-REPLACEMENT']);
            expect([...folder.docs.values()].filter((doc) => doc.name.startsWith('.mindwtr-et-q-')).map((doc) => decodeText(doc.bytes)))
                .toEqual(pathIds ? ['PEER-REPLACEMENT'] : []);
        });
    }

    it('refuses an attachment install when a peer took its name after the old copy was moved aside, keeping both copies', async () => {
        const folder = safFolder();
        let taken = false;
        folder.peer((op, name) => {
            if (taken || op !== 'read' || !name.startsWith('.mindwtr-et-q-')) return;
            taken = true;
            const dir = [...folder.docs.values()].find((doc) => doc.name === name)!.parent;
            folder.add(dir, 'file-0.txt', encodeText('PEER-COPY'));
        });
        const { outcome } = await enableOver(folder);
        expect(outcome).toBe('SyncEncryptionRemoteConflictError');
        expect([...folder.docs.values()].filter((doc) => doc.name === 'file-0.txt').map((doc) => decodeText(doc.bytes)))
            .toEqual(['PEER-COPY']);
        expect([...folder.docs.values()].filter((doc) => doc.name.startsWith('.mindwtr-et-q-')).map((doc) => decodeText(doc.bytes)))
            .toEqual(['attachment 0']);
    });

    it('passes over an empty name probe a cut-off transition left, and removes it at the next probe', async () => {
        const folder = safFolder();
        const { outcome, keys, attachmentsDir } = await enableOver(folder);
        expect(outcome).toBe('ok');

        folder.add(attachmentsDir, '.mindwtr-et-p-mvn0-1-left', new Uint8Array(0));
        folder.add(attachmentsDir, '.mindwtr-et-p-mvn0-1-left (1)', new Uint8Array(0));
        const { host, logged } = fakeHost({ saf: folder.port as never, crypto: defaultSyncCryptoPrimitives });
        const remote = (await createMobileFileSync(host).createFileSyncEncryptionRemotePort(safChild('data.json')))!;
        await runChangeSyncEncryptionPassphraseOverRemote('correct horse', 'battery staple', remote, keys.keyCache, keys.localState,
            undefined, defaultSyncCryptoPrimitives, CHEAP_KDF);
        expect(folder.named(attachmentsDir).map((doc) => doc.name).sort()).toEqual(['file-0.txt', 'file-1.txt', 'file-2.txt']);
        expect(logged.filter((entry) => entry.message === 'File Sync transition chose its name check')
            .map((entry) => (entry.context as { extra: unknown }).extra))
            .toEqual([{ releaseCheck: 'v1.3.8/file-sync-name-probe', mode: 'unique-names', outcome: 'renamed', cleaned: 'yes' }]);
    });

    it('logs the transition line from a transition only, not from a listing that wrote nothing', async () => {
        const folder = safFolder();
        const { outcome, logged } = await enableOver(folder);
        expect(outcome).toBe('ok');
        const lines = () => logged.filter((entry) => entry.message === 'File Sync transition final check listed names only');
        expect(lines().map((entry) => (entry.context as { extra: { writes: number } }).extra.writes)).toEqual([4]);
        const { host, logged: probeLogged } = fakeHost({ saf: folder.port as never });
        await (await createMobileFileSync(host).createFileSyncEncryptionRemotePort(safChild('data.json')))!.list();
        expect(probeLogged.some((entry) => entry.message === 'File Sync transition final check listed names only')).toBe(false);
    });
});

describe('File Sync encryption transition cost', () => {


    const run = async (count: number, create: 'decorate' | 'duplicate' | 'return-existing' = 'decorate') => {
        const folder = safFolder({ create });
        const encode = (text: string) => new TextEncoder().encode(text);
        folder.add(folder.root, 'data.json', encode(JSON.stringify(data)));
        const attachmentsDir = folder.add(folder.root, 'attachments', null);
        for (let i = 0; i < count; i += 1) folder.add(attachmentsDir, `file-${i}.txt`, encode(`attachment ${i} `.repeat(20)));
        const { host, logged } = fakeHost({ saf: folder.port as never, crypto: defaultSyncCryptoPrimitives });
        const sync = createMobileFileSync(host);
        let state: SyncEncryptionLocalState | null = null;
        let key: Uint8Array | null = null;
        const keyCache = { getKey: async () => key, setKey: async (next: Uint8Array) => { key = next; }, clearKey: async () => { key = null; } };
        const localState = { read: () => state, write: (next: SyncEncryptionLocalState | null) => { state = next; } };
        const cost = async (transition: () => Promise<unknown>) => {
            const before = { ...folder.calls };
            await transition();
            return { list: folder.calls.list - before.list, read: folder.calls.read - before.read };
        };
        const open = async () => (await sync.createFileSyncEncryptionRemotePort(safChild('data.json')))!;
        const enable = await cost(async () => runEnableSyncEncryptionOverRemote('correct horse', await open(), keyCache, localState,
            undefined, defaultSyncCryptoPrimitives, { mKib: 8, t: 1, p: 1 }));
        const sealed = [...folder.docs.values()].filter((doc) => doc.parent === attachmentsDir);
        expect(sealed).toHaveLength(count);
        expect(sealed.every((doc) => new TextDecoder().decode(doc.bytes!.subarray(0, 6)) === 'MWENC1')).toBe(true);
        const disable = await cost(async () => runDisableSyncEncryptionOverRemote(await open(), keyCache, localState));
        const opened = [...folder.docs.values()].filter((doc) => doc.parent === attachmentsDir);
        expect(opened.map((doc) => new TextDecoder().decode(doc.bytes!)).sort())
            .toEqual(Array.from({ length: count }, (_, i) => `attachment ${i} `.repeat(20)).sort());
        expect(folder.docs.size).toBe(count + 2);

        const lines = logged.filter((entry) => entry.message === 'File Sync transition final check listed names only');
        expect(lines.map((entry) => (entry.context as { extra: { entries: number; writes: number } }).extra))
            .toMatchObject([{ entries: count + 10, writes: count + 1 }, { entries: count + 10, writes: count + 1 }]);

        const modes = logged.filter((entry) => entry.message === 'File Sync transition chose its name check')
            .map((entry) => (entry.context as { extra: { mode: string; outcome: string } }).extra);
        return { enable, disable, modes };
    };

    it('costs each attachment at most two folder listings and seven reads, Enable and Disable alike', async () => {
        const small = await run(10);
        const large = await run(30);
        for (const kind of ['enable', 'disable'] as const) {
            expect((large[kind].list - small[kind].list) / 20, `${kind} listings per attachment`).toBeLessThanOrEqual(2);
            expect((large[kind].read - small[kind].read) / 20, `${kind} reads per attachment`).toBeLessThanOrEqual(7);
        }
    });

    it('lists no folder per attachment on a provider proved to rename a taken name, as Android\'s external storage does', async () => {
        const small = await run(10);
        const large = await run(30);
        for (const kind of ['enable', 'disable'] as const) {
            expect(large[kind].list - small[kind].list, `${kind} listings for 20 more attachments`).toBe(0);
        }
        expect(large.modes).toEqual([{ releaseCheck: 'v1.3.8/file-sync-name-probe', mode: 'unique-names', outcome: 'renamed', cleaned: 'yes' },
            { releaseCheck: 'v1.3.8/file-sync-name-probe', mode: 'unique-names', outcome: 'renamed', cleaned: 'yes' }]);
    });

    it('keeps both listings per attachment where the probe sees a taken name kept or handed back', async () => {
        for (const [create, outcome] of [['duplicate', 'kept-name'], ['return-existing', 'handed-back']] as const) {
            const small = await run(10, create);
            const large = await run(30, create);
            for (const kind of ['enable', 'disable'] as const) {
                expect((large[kind].list - small[kind].list) / 20, `${create} ${kind} listings per attachment`).toBe(2);
            }
            expect(large.modes.map((line) => [line.mode, line.outcome])).toEqual([['full-listing', outcome], ['full-listing', outcome]]);
        }
    });
});
