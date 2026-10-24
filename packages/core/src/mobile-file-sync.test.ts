import { describe, expect, it } from 'vitest';

import { FILE_SYNC_ABSENT_FINGERPRINT, createMobileFileSync, type MobileFileSyncFullHost } from './mobile-file-sync';
import { fileSyncErrorCode } from './mobile-file-sync-remote';
import { SyncEncryptionRemoteConflictError } from './sync-encryption';
import type { AppData } from './types';

// File Sync's log contexts never carry the sync folder's path or a document URI: a provider's or the file system's error text
// quotes them, and they name the user and their files. Each site logs the error's code or name instead.
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
            // The diagnostics builder logs an error line's message and stack: both count as logged text.
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

/** A plain folder in memory; [refuse] makes one file name fail with an error that quotes its path. */
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
    // Removed-await controls must fail assertions, not create unhandled rejections.
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
        const markers = () => logged.filter((entry) => JSON.stringify(entry.context).includes('v1.3.8/file-sync-path-await'));
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
                scope: 'sync', extra: { releaseCheck: 'v1.3.8/file-sync-path-await', operation: 'rename', outcome: 'completed' },
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
            expect(logged.some((entry) => JSON.stringify(entry.context).includes('v1.3.8/file-sync-path-await'))).toBe(false);
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
                // The provider decorates the write's stage name, as #1113's providers add ".bin".
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
