import { afterEach, describe, expect, it } from 'bun:test';
import * as core from '@mindwtr/core';
import { SYNC_BACKEND_KEY, SYNC_PATH_KEY, resetForTests, setLogger, type AppData } from '@mindwtr/core';
import { defaultSyncCryptoPrimitives } from '../../../packages/core/src/sync-crypto';
import { createNativeSync } from './host-sync';

// File Sync on the Android host (S5): core's File Sync, lock and diagnostics line on the host's SAF and lock channels
// (HostDocuments.kt, HostSyncLock.kt), with an in-memory externalstorage tree standing in for the provider.
const globals = globalThis as unknown as Record<string, unknown>;
const channelGlobals = ['__mindwtrHostPlatform', '__mindwtrDocumentCall', '__mindwtrSyncLockCall', '__mindwtrCryptoCall'];
const originalGlobals = new Map(channelGlobals.map((name) => [name, globals[name]]));

const AUTHORITY = 'com.android.externalstorage.documents';
const TREE = `content://${AUTHORITY}/tree/primary%3AMindwtr`;
const ROOT = `${TREE}/document/primary%3AMindwtr`;
const childUri = (name: string) => `${TREE}/document/primary%3AMindwtr%2F${encodeURIComponent(name)}`;

const provider = () => {
    const docs = new Map<string, { name: string; bytes: Uint8Array }>();
    const ops: string[] = [];
    let revoked = false;
    /** The host's pick slot (PendingSyncFolderPick.kt): what Settings › Sync's picker left, taken once. */
    let pick: Record<string, unknown> | null = null;
    const refuse = () => { if (revoked) throw new Error('SAF_DOCUMENTS_UNAVAILABLE: permission revoked'); };
    const row = (uri: string) => {
        const doc = docs.get(uri);
        return doc ? { uri, name: doc.name, mime: 'application/octet-stream', size: doc.bytes.length, lastModified: 1 } : null;
    };
    const call = async (request: Record<string, unknown>, bytes?: Uint8Array) => {
        const op = String(request.op);
        const uri = String(request.uri);
        ops.push(op);
        if (op === 'takePick') {
            const taken = pick;
            pick = null;
            return { value: taken, bytes: null };
        }
        refuse();
        switch (op) {
            case 'listChildren':
                if (uri !== ROOT && uri !== TREE) throw new Error('SAF_DOCUMENTS_UNAVAILABLE: not a folder');
                return { value: [...docs.keys()].map(row), bytes: null };
            case 'stat': return { value: uri === ROOT ? { uri, name: 'Mindwtr', size: null } : row(uri), bytes: null };
            case 'read': {
                const doc = docs.get(uri);
                if (!doc) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                return { value: { lengthVerified: true }, bytes: doc.bytes.slice() };
            }
            case 'write': {
                const doc = docs.get(uri);
                if (!doc) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                doc.bytes = bytes!.slice();
                return { value: null, bytes: null };
            }
            case 'createFile': {
                const name = String(request.name);
                const created = childUri(name);
                if (docs.has(created)) throw new Error('exists');
                docs.set(created, { name, bytes: new Uint8Array(0) });
                return { value: created, bytes: null };
            }
            case 'delete': docs.delete(uri); return { value: null, bytes: null };
            case 'rename': {
                const doc = docs.get(uri);
                if (!doc) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                const name = String(request.name);
                docs.delete(uri);
                docs.set(childUri(name), { name, bytes: doc.bytes });
                return { value: { uri: childUri(name), name }, bytes: null };
            }
            default: throw new Error(`unexpected ${op}`);
        }
    };
    const put = (name: string, text: string) => docs.set(childUri(name), { name, bytes: new TextEncoder().encode(text) });
    const text = (name: string) => {
        const doc = docs.get(childUri(name));
        return doc ? new TextDecoder().decode(doc.bytes) : null;
    };
    return { call, docs, ops, put, text, revoke: () => { revoked = true; }, picked: (value: Record<string, unknown>) => { pick = value; } };
};

const lock = () => {
    const calls: string[] = [];
    let busy = false;
    let revoked = false;
    const call = async (request: Record<string, unknown>) => {
        calls.push(`${request.op}`);
        if (request.op === 'acquire') {
            if (revoked) throw new Error('SYNC_FILE_LOCK_UNAVAILABLE: lease authority is unavailable');
            if (busy) throw new Error('SYNC_FILE_LOCK_BUSY: another File Sync operation is active');
            expect(request.uri).toBe(ROOT);
            return 'token-1';
        }
        return null;
    };
    return { call, calls, hold: () => { busy = true; }, revoke: () => { revoked = true; } };
};

const local: AppData = {
    tasks: [{ id: 't1', title: 'mine', status: 'inbox', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' } as never],
    projects: [], sections: [], areas: [], settings: {},
};

const host = (stored: Record<string, string>) => {
    const kv = new Map(Object.entries(stored));
    const entries: core.DiagnosticsLogEntry[] = [];
    const saved: AppData[] = [];
    const secrets = new Map<string, string>();
    core.setStorageAdapter({ getData: async () => structuredClone(local), saveData: async () => undefined });
    const sync = createNativeSync({
        keyValue: {
            get: async (key) => kv.get(key) ?? null,
            set: async (key, value) => { kv.set(key, value); },
            remove: async (key) => { kv.delete(key); },
            multiGet: async (keys) => keys.map((key) => [key, kv.get(key) ?? null] as [string, string | null]),
            multiSet: async (pairs) => { for (const [key, value] of pairs) kv.set(key, value); },
        },
        secrets: {
            getSecret: async (key) => secrets.get(key) ?? null,
            setSecret: async (key, value) => { secrets.set(key, value); },
            deleteSecret: async (key) => { secrets.delete(key); },
        },
        localData: () => ({ getData: async () => structuredClone(local), saveData: async (data) => { saved.push(data); } }),
        networkState: () => ({ isConnected: true, isInternetReachable: true }),
        appendLog: async (entry) => { entries.push(entry); return null; },
        translate: (key) => key,
        emit: () => undefined,
        trace: () => undefined,
        scheduleBackgroundSync: () => undefined,
        isFossBuild: false,
    });
    const cycleLine = () => entries.filter((entry) => entry.message === 'Native Android File Sync cycle').map((entry) => entry.context);
    const contract = async () => {
        const opened = core.createNativeHostContract({ syncSettings: sync.settingsHost });
        const activated = await opened.activate({ writeSafetyReady: true });
        expect(activated).toMatchObject({ ok: true });
        expect((await opened.openSyncSettings({})).ok).toBe(true);
        return opened;
    };
    return { sync, entries, saved, cycleLine, kv, contract };
};

const install = () => {
    resetForTests();
    setLogger(() => undefined);
    globals.__mindwtrHostPlatform = 'android';
    const folder = provider();
    const folderLock = lock();
    globals.__mindwtrDocumentCall = folder.call;
    globals.__mindwtrSyncLockCall = folderLock.call;
    return { folder, folderLock };
};

afterEach(async () => {
    // A cycle's store save is still pending when a test ends: the next test's contract cannot load over it.
    await core.flushPendingSave().catch(() => undefined);
    resetForTests();
    setLogger(null);
    for (const name of channelGlobals) {
        const original = originalGlobals.get(name);
        if (original === undefined) delete globals[name];
        else globals[name] = original;
    }
});

describe('native Android File Sync', () => {
    // First: core's store keeps a cycle's merged rows across tests, and the contract's activation refuses a store holding rows
    // its storage lacks (the merge test's peer row).
    describe('Select folder (the pick slot)', () => {
        const pick = async (contract: Awaited<ReturnType<ReturnType<typeof host>['contract']>>, requestId = core.generateUUID()) => {
            const result = await contract.pickSyncFolder({ requestId });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };

        it('an empty slot is a cancel: nothing is stored and nothing syncs', async () => {
            const { folder, folderLock } = install();
            const { kv, contract } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
            const before = [...kv];
            expect((await pick(await contract())).toasts).toEqual([]);
            expect([...kv]).toEqual(before);
            expect(folder.ops).toEqual(['takePick']);
            expect(folderLock.calls).toEqual([]);
        });

        it('a picked folder is stored as the sync path and activates through its first sync; the slot is taken once', async () => {
            const { folder } = install();
            const { kv, contract, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file' });
            folder.picked({ treeUri: TREE });
            const opened = await contract();
            const requestId = core.generateUUID();
            const first = await pick(opened, requestId);
            expect(first.toasts.filter((toast) => toast.tone === 'error')).toEqual([]);
            // The folder's sync file by name, created only when the first cycle published it.
            expect(kv.get(SYNC_PATH_KEY)).toBe(childUri('data.json'));
            expect(kv.get(SYNC_BACKEND_KEY)).toBe('file');
            expect(JSON.parse(folder.text('data.json')!).tasks.map((task: { title: string }) => task.title)).toEqual(['mine']);
            expect(cycleLine().length).toBeGreaterThan(0);
            expect(cycleLine().every((line) => line?.outcome === 'synced' && line.provider === AUTHORITY)).toBe(true);
            // The probe left nothing behind, and a replayed request takes nothing twice.
            expect([...folder.docs.values()].map((doc) => doc.name)).toEqual(['data.json']);
            const takes = folder.ops.filter((op) => op === 'takePick').length;
            expect(await pick(opened, requestId)).toEqual(first);
            expect(folder.ops.filter((op) => op === 'takePick').length).toBe(takes);
        });

        it('a refused grant shows RN\'s failed-to-set-path toast and stores nothing', async () => {
            const { folder } = install();
            const { kv, contract, entries } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
            folder.picked({ grant: 'refused' });
            const before = [...kv];
            const result = await pick(await contract());
            expect(result.toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Error', message: 'Failed to set sync path' })]);
            expect([...kv]).toEqual(before);
            expect(folder.ops).toEqual(['takePick']);
            expect(entries.some((entry) => entry.context?.operation === 'import')).toBe(true);
        });
    });

    it('syncs a picked SAF folder under the folder lock and logs the synced cycle', async () => {
        const { folder, folderLock } = install();
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        const result = await sync.settingsHost.performSync(undefined, { manual: true });
        expect(result).toMatchObject({ success: true });
        expect(JSON.parse(folder.text('data.json')!).tasks.map((task: { title: string }) => task.title)).toEqual(['mine']);
        expect(folderLock.calls[0]).toBe('acquire');
        expect(folderLock.calls.at(-1)).toBe('release');
        expect(cycleLine()).toEqual([{
            releaseCheck: 'v1.3.8/native-file-sync', outcome: 'synced', provider: AUTHORITY, encrypted: 'no', retained: '0',
        }]);
        expect(JSON.stringify(cycleLine())).not.toContain('mine');
    });

    it('merges the folder\'s data.json and writes the merged file back', async () => {
        const { folder } = install();
        folder.put('data.json', JSON.stringify({ ...local, tasks: [{ ...local.tasks[0], id: 't2', title: 'peer' }] }));
        const { sync, saved } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        const titles = JSON.parse(folder.text('data.json')!).tasks.map((task: { title: string }) => task.title).sort();
        expect(titles).toEqual(['mine', 'peer']);
        expect(saved.at(-1)?.tasks.map((task) => task.title).sort()).toEqual(['mine', 'peer']);
    });

    it('enables encryption on the folder under its lock, then syncs the encrypted file', async () => {
        const { folder, folderLock } = install();
        // The host's crypto channel (HostCrypto.kt) with a fast stand-in key derivation; AES-GCM stays real.
        globals.__mindwtrCryptoCall = async (request: Record<string, unknown>) => {
            const bytes = (name: string) => request[name] as Uint8Array;
            if (request.op === 'argon2id') {
                const pass = bytes('pass');
                const salt = bytes('salt');
                return Uint8Array.from({ length: request.dkLen as number }, (_, index) => (pass[index % pass.length] ^ salt[index % salt.length] ^ index) & 0xff);
            }
            if (request.op === 'aesGcmSeal') return defaultSyncCryptoPrimitives.aesGcmSeal(bytes('key'), bytes('nonce'), bytes('data'), bytes('aad'));
            return defaultSyncCryptoPrimitives.aesGcmOpen(bytes('key'), bytes('nonce'), bytes('data'), bytes('aad'));
        };
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        const acquiresBefore = folderLock.calls.filter((op) => op === 'acquire').length;
        await sync.settingsHost.encryption.transitions!.enable('correct horse battery staple');
        expect(folderLock.calls.filter((op) => op === 'acquire').length).toBe(acquiresBefore + 1);
        expect(folder.text('data.json')).toBeNull();
        expect(folder.text('data.json.enc')?.startsWith('MWENC1')).toBe(true);
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(cycleLine().at(-1)).toEqual(expect.objectContaining({ outcome: 'synced', encrypted: 'yes' }));
        expect(JSON.stringify(folder.text('data.json.enc'))).not.toContain('mine');
    });

    it('a held folder lock defers the cycle, writes nothing and logs lock-busy', async () => {
        const { folder, folderLock } = install();
        folderLock.hold();
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ skipped: 'fileSyncLockBusy' });
        expect(folder.docs.size).toBe(0);
        expect(cycleLine()).toEqual([expect.objectContaining({ outcome: 'lock-busy', provider: AUTHORITY })]);
    });

    it('a revoked folder writes nothing and logs lock-unavailable', async () => {
        const { folder, folderLock } = install();
        folder.revoke();
        folderLock.revoke();
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(folder.ops.filter((op) => op === 'write' || op === 'createFile')).toEqual([]);
        expect(cycleLine()).toEqual([expect.objectContaining({ outcome: 'lock-unavailable' })]);
    });

    it('a damaged data.json beside a retained copy stops the cycle with the copy counted', async () => {
        const { folder } = install();
        folder.put('data.json', '{"tasks": [');
        folder.put('data.json.bak', JSON.stringify(local));
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: ROOT });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(folder.text('data.json')).toBe('{"tasks": [');
        expect(cycleLine()).toEqual([expect.objectContaining({ outcome: 'retained-refused', retained: '1' })]);
    });

    it('refuses a file:// sync path without touching the folder', async () => {
        const { folder, folderLock } = install();
        const { sync, cycleLine } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: 'file:///sdcard/Mindwtr/data.json' });
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(folder.ops).toEqual([]);
        expect(folderLock.calls.filter((op) => op === 'acquire')).toEqual([]);
        expect(cycleLine()).toEqual([expect.objectContaining({ outcome: 'failed', provider: 'none' })]);
    });

    it('logs no File Sync line for a cycle that never reached File Sync', async () => {
        install();
        const { sync, cycleLine } = host({});
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(cycleLine()).toEqual([]);
    });
});
