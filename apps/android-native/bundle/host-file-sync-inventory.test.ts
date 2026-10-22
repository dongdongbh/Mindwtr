import { afterEach, describe, expect, it } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import * as core from '@mindwtr/core';
import { SYNC_BACKEND_KEY, SYNC_PATH_KEY, resetForTests, setLogger, type AppData, type Attachment } from '@mindwtr/core';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import { createNativeAttachments } from './host-attachments';
import { createHostSafPort, createHostSyncCrypto, createNativeSync } from './host-sync';

// RN's File Sync fix history (rn-fix-inventory.md lines marked "NEW bundle"), each run through native's own binding
// (createNativeSync) over the host's channels: a provider tree with an `attachments/` folder (HostDocuments.kt), the folder lock
// (HostSyncLock.kt), the app's private files and installer (HostFiles.kt, HostInstaller.kt) and the crypto calls (HostCrypto.kt).
const globals = globalThis as unknown as Record<string, unknown>;
const channelGlobals = ['__mindwtrHostPlatform', '__mindwtrDocumentCall', '__mindwtrSyncLockCall', '__mindwtrCryptoCall',
    '__mindwtrFileCall', '__mindwtrInstallerCall', '__mindwtrNative'];
const originalGlobals = new Map(channelGlobals.map((name) => [name, globals[name]]));
const originalSetTimeout = globalThis.setTimeout;

const AUTHORITY = 'com.android.externalstorage.documents';
const TREE = `content://${AUTHORITY}/tree/primary%3AMindwtr`;
const ROOT = `${TREE}/document/primary%3AMindwtr`;
const DATE = '2026-10-18T00:00:00.000Z';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => new TextEncoder().encode(value);

/** The picked tree (HostDocuments.kt over externalstorage): `path` is relative to the picked folder, `attachments/x` included. */
const provider = (top = 'Mindwtr') => {
    const tree = `content://${AUTHORITY}/tree/primary%3A${encodeURIComponent(top)}`;
    const root = `${tree}/document/primary%3A${encodeURIComponent(top)}`;
    const uriOf = (path: string) => `${tree}/document/${encodeURIComponent(`primary:${top}/${path}`)}`;
    const nodes = new Map<string, { name: string; parent: string; dir: boolean; bytes: Uint8Array }>();
    const ops: string[] = [];
    /** A fault makes the next matching call throw. */
    const faults: { op: string; name?: string; error: Error }[] = [];
    const pauses: { op: string; name?: string; reached: () => void; go: Promise<Error | undefined> }[] = [];
    /** One-shot: runs `run` when the next `op` arrives. */
    const hooks: { op: string; run: () => void }[] = [];
    const children = (uri: string) => [...nodes].filter(([, node]) => node.parent === uri).map(([child, node]) => ({
        uri: child, name: node.name, mime: node.dir ? 'vnd.android.document/directory' : 'application/octet-stream',
        size: node.dir ? null : node.bytes.length, lastModified: 1,
    }));
    const add = (parent: string, name: string, dir: boolean, bytes: Uint8Array = new Uint8Array(0)) => {
        const parentPath = parent === root ? '' : `${decodeURIComponent(parent.slice(`${tree}/document/primary%3A${encodeURIComponent(top)}%2F`.length))}/`;
        const uri = uriOf(`${parentPath}${name}`);
        if (nodes.has(uri)) throw new Error(`exists ${name}`);
        nodes.set(uri, { name, parent, dir, bytes });
        return uri;
    };
    const call = async (request: Record<string, unknown>, bytes?: Uint8Array) => {
        const op = String(request.op);
        const uri = String(request.uri);
        const name = (request.name as string | undefined) ?? nodes.get(uri)?.name;
        ops.push(`${op} ${name ?? (uri === root || uri === tree ? '/' : uri)}`);
        const fault = faults.findIndex((entry) => entry.op === op && (!entry.name || entry.name === name));
        if (fault >= 0) throw faults.splice(fault, 1)[0].error;
        const hook = hooks.findIndex((entry) => entry.op === op);
        if (hook >= 0) hooks.splice(hook, 1)[0].run();
        const paused = pauses.findIndex((entry) => entry.op === op && (!entry.name || Boolean(name?.startsWith(entry.name))));
        if (paused >= 0) {
            const [entry] = pauses.splice(paused, 1);
            entry.reached();
            const error = await entry.go;
            if (error) throw error;
        }
        const folder = uri === tree ? root : uri;
        switch (op) {
            case 'listChildren':
                if (folder !== root && !nodes.get(folder)?.dir) throw new Error('SAF_DOCUMENTS_UNAVAILABLE: not a folder');
                return { value: children(folder), bytes: null };
            case 'stat': {
                if (folder === root) return { value: { uri, name: top, size: null }, bytes: null };
                const node = nodes.get(uri);
                return { value: node ? { uri, name: node.name, size: node.dir ? null : node.bytes.length } : null, bytes: null };
            }
            case 'read': {
                const node = nodes.get(uri);
                if (!node) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                return { value: { lengthVerified: true }, bytes: node.bytes.slice() };
            }
            case 'write': {
                const node = nodes.get(uri);
                if (!node) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                node.bytes = bytes!.slice();
                return { value: null, bytes: null };
            }
            case 'createFile': return { value: add(folder, String(request.name), false), bytes: null };
            case 'makeDirectory': return { value: add(folder, String(request.name), true), bytes: null };
            case 'delete': nodes.delete(uri); return { value: null, bytes: null };
            case 'rename': {
                const node = nodes.get(uri);
                if (!node) throw new Error('SAF_DOCUMENT_UNAVAILABLE: missing');
                nodes.delete(uri);
                const renamed = add(node.parent, String(request.name), node.dir, node.bytes);
                return { value: { uri: renamed, name: String(request.name) }, bytes: null };
            }
            default: throw new Error(`unexpected ${op}`);
        }
    };
    const put = (path: string, bytes: Uint8Array) => {
        const parts = path.split('/');
        let parent = root;
        for (const dir of parts.slice(0, -1)) {
            parent = [...nodes].find(([, node]) => node.parent === parent && node.name === dir)?.[0] ?? add(parent, dir, true);
        }
        const existing = uriOf(path);
        if (nodes.has(existing)) nodes.get(existing)!.bytes = bytes.slice();
        else add(parent, parts.at(-1)!, false, bytes.slice());
        return existing;
    };
    const read = (path: string) => nodes.get(uriOf(path))?.bytes;
    const names = (dir = '') => [...nodes.values()].filter((node) => node.parent === (dir ? uriOf(dir) : root)).map((node) => node.name).sort();
    const fail = (op: string, error: Error, name?: string) => { faults.push({ op, name, error }); };
    /** The next `op` (on a name starting `name`) waits until released: `at` resolves once it waits; `release(error)` fails it. */
    const pause = (op: string, name?: string) => {
        let reached!: () => void;
        let release!: (error?: Error) => void;
        const at = new Promise<void>((resolve) => { reached = resolve; });
        const go = new Promise<Error | undefined>((resolve) => { release = resolve; });
        pauses.push({ op, name, reached, go });
        return { at, release };
    };
    return { call, nodes, ops, put, read, names, fail, pause, uriOf, root, tree, when: (op: string, run: () => void) => { hooks.push({ op, run }); } };
};

/** HostSyncLock.kt: one lease per folder at a time; a token is held until released. */
const lock = () => {
    const calls: string[] = [];
    const held = new Set<string>();
    let next = 0;
    let busy = false;
    let releaseError: Error | null = null;
    /** Scripted answers for the next acquires: 'busy' refuses one as another holder would. */
    const script: ('busy' | 'grant')[] = [];
    const call = async (request: Record<string, unknown>) => {
        calls.push(`${request.op}`);
        if (request.op === 'acquire') {
            if (script.shift() === 'busy' || busy || held.size > 0) throw new Error('SYNC_FILE_LOCK_BUSY: another File Sync operation is active');
            next += 1;
            held.add(`token-${next}`);
            return `token-${next}`;
        }
        if (request.op === 'release') {
            held.delete(String(request.token));
            if (releaseError) throw releaseError;
        }
        return null;
    };
    return { call, calls, held, script, hold: (on = true) => { busy = on; }, failRelease: (error: Error | null) => { releaseError = error; } };
};

/** The app's private files (HostFiles.kt), with a picked `content://` document read through the provider as expo reads it. */
const appFiles = (folder: ReturnType<typeof provider>) => {
    const memory = createMemoryFileSystem();
    const calls: string[] = [];
    /** A size the file system reports for a file instead of its bytes' length (an oversized attachment without the bytes). */
    const sizes = new Map<string, number>();
    const contentBytes = (uri: string) => {
        const node = folder.nodes.get(uri);
        if (!node) throw new Error(`ENOENT: ${uri}`);
        return node.bytes.slice();
    };
    const files = async (request: Record<string, unknown>, body?: Uint8Array) => {
        const op = String(request.op);
        const uri = String(request.uri ?? '');
        calls.push(`${op} ${uri.startsWith('content://') ? 'content' : uri.replace(DOCUMENTS, '').replace(CACHE, 'cache/')}`);
        if (uri.startsWith('content://')) {
            switch (op) {
                case 'getInfo': {
                    const node = folder.nodes.get(uri);
                    return node ? { exists: true, size: node.bytes.length, modificationTime: 1 } : { exists: false };
                }
                case 'readBytes': return contentBytes(uri);
                case 'copy': memory.put(String(request.to), contentBytes(uri)); return null;
                case 'sha256File': return digest(contentBytes(uri));
                // HostFiles refuses to change a picked document: only HostDocuments writes the folder.
                default: throw new Error(`HostFiles refuses ${op} on a content:// document`);
            }
        }
        switch (op) {
            case 'barrier': case 'syncParent': return null;
            case 'sha256': return digest(body!);
            case 'sha256File': return digest(memory.read(uri)!);
            case 'getInfo': {
                const info = await memory.fs.getInfo(uri);
                return info.exists && sizes.has(uri) ? { ...info, size: sizes.get(uri) } : info;
            }
            case 'makeDirectory': return memory.fs.makeDirectory(uri);
            case 'readDirectory': return memory.fs.readDirectory(uri);
            case 'readBytes': return memory.fs.readBytes(uri);
            case 'readBytesRange': return memory.fs.readBytesRange(uri, Number(request.position), Number(request.length));
            case 'writeBytes': return memory.fs.writeBytes(uri, body!);
            case 'copy': return memory.fs.copy(uri, String(request.to));
            case 'move': return memory.fs.move(uri, String(request.to));
            case 'delete': return memory.fs.delete(uri);
            default: throw new Error(`unexpected file op ${op}`);
        }
    };
    // HostInstaller.kt (RN's AttachmentFileInstallerCore): a staged download replaces the target only as expected.
    const installs: string[] = [];
    const installer = async (request: Record<string, unknown>) => {
        if (request.op === 'hash') {
            const bytes = memory.read(String(request.path));
            if (!bytes) throw new Error('ENOENT');
            return { sha256: digest(bytes), size: sizes.get(String(request.path)) ?? bytes.length, modificationTimeMs: 1 };
        }
        const staged = String(request.staged);
        const target = String(request.target);
        const bytes = memory.read(staged);
        if (!bytes || digest(bytes) !== request.expectedDownloadSha256) throw new Error('ATTACHMENT_INSTALL_STAGED_HASH_MISMATCH');
        const expected = request.expected as { kind: string; sha256?: string };
        const current = memory.read(target);
        installs.push(`${expected.kind} ${target.replace(DOCUMENTS, '')}`);
        // Absent: a different file at the target is a conflict (the stage is kept), the same bytes are taken as installed.
        // Present: only the expected local generation is replaced.
        if (expected.kind === 'absent' ? current && digest(current) !== request.expectedDownloadSha256
            : !current || digest(current) !== expected.sha256) {
            return { status: 'conflict', preservedPath: staged };
        }
        memory.put(target, bytes);
        memory.files.delete(staged);
        return { status: 'installed' };
    };
    const native = {
        fileDirectories: () => JSON.stringify({ document: DOCUMENTS, cache: CACHE }),
        fileDeleteNow: (uri: string) => { calls.push(`deleteNow ${uri}`); memory.files.delete(uri); },
    };
    return { memory, calls, files, installer, native, installs, sizes };
};

/** HostCrypto.kt with a fast stand-in key derivation; AES-GCM stays real (Java's, here node's: the engine has no WebCrypto). */
const cryptoCall = async (request: Record<string, unknown>) => {
    const bytes = (name: string) => request[name] as Uint8Array;
    if (request.op === 'argon2id') {
        const pass = bytes('pass');
        const salt = bytes('salt');
        return Uint8Array.from({ length: request.dkLen as number }, (_, index) => (pass[index % pass.length] ^ salt[index % salt.length] ^ index) & 0xff);
    }
    if (request.op === 'aesGcmSeal') {
        const cipher = createCipheriv('aes-256-gcm', bytes('key'), bytes('nonce')).setAAD(bytes('aad'));
        return new Uint8Array(Buffer.concat([cipher.update(bytes('data')), cipher.final(), cipher.getAuthTag()]));
    }
    const sealed = bytes('data');
    try {
        const decipher = createDecipheriv('aes-256-gcm', bytes('key'), bytes('nonce')).setAAD(bytes('aad'));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]));
    } catch {
        throw Object.assign(new Error('AES-GCM authentication failed'), { code: 'auth' });
    }
};

const task = (id: string, title: string, attachments?: Attachment[]) => ({
    id, title, status: 'inbox', tags: [], contexts: [], createdAt: DATE, updatedAt: DATE, ...(attachments ? { attachments } : {}),
}) as AppData['tasks'][number];
const fileAttachment = (id: string, fields: Partial<Attachment> = {}): Attachment => ({
    id, kind: 'file', title: `${id}.txt`, uri: `${MANAGED}${id}.txt`, mimeType: 'text/plain', localStatus: 'available',
    createdAt: DATE, updatedAt: DATE, ...fields,
});

/** Core's follow-up timers from a test's cycles, cleared when it ends so no cycle outlives its test. */
const timers = new Set<ReturnType<typeof setTimeout>>();
const trackTimers = () => {
    globalThis.setTimeout = ((run: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const handle: ReturnType<typeof setTimeout> = originalSetTimeout(() => { timers.delete(handle); run(...args); }, delay);
        timers.add(handle);
        return handle;
    }) as typeof setTimeout;
};

const install = (options: { files?: boolean; others?: string[] } = {}) => {
    trackTimers();
    resetForTests();
    // A cycle's merged rows stay in core's store; each test starts from an empty one.
    core.useTaskStore.setState(core.useTaskStore.getInitialState(), true);
    core.clearIdleSyncCycleSnapshot();
    setLogger(() => undefined);
    globals.__mindwtrHostPlatform = 'android';
    const folder = provider();
    const others = new Map((options.others ?? []).map((top) => [top, provider(top)]));
    const folderLock = lock();
    /** The host's pick slot (PendingSyncFolderPick.kt), taken once. */
    let pick: Record<string, unknown> | null = null;
    globals.__mindwtrDocumentCall = async (request: Record<string, unknown>, bytes?: Uint8Array) => {
        if (request.op === 'takePick') {
            const taken = pick;
            pick = null;
            return { value: taken, bytes: null };
        }
        const owner = [...others.values()].find((other) => String(request.uri).startsWith(other.tree)) ?? folder;
        return owner.call(request, bytes);
    };
    globals.__mindwtrSyncLockCall = folderLock.call;
    globals.__mindwtrCryptoCall = cryptoCall;
    const app = appFiles(folder);
    if (options.files !== false) {
        globals.__mindwtrFileCall = app.files;
        globals.__mindwtrInstallerCall = app.installer;
        globals.__mindwtrNative = app.native;
    } else {
        delete globals.__mindwtrFileCall;
        delete globals.__mindwtrInstallerCall;
        delete globals.__mindwtrNative;
    }
    return { folder, others, folderLock, app, picked: (treeUri: string) => { pick = { treeUri }; } };
};

/** A host over RN's AsyncStorage keys (`stored`), its keystore and the local snapshot (`data`), shared across host instances. */
const host = (stored: Record<string, string>, data: AppData = { tasks: [task('t1', 'mine')], projects: [], sections: [], areas: [], settings: {} },
    shared?: { kv: Map<string, string>; secrets: Map<string, string> }) => {
    const kv = shared?.kv ?? new Map(Object.entries(stored));
    const secrets = shared?.secrets ?? new Map<string, string>();
    const entries: core.DiagnosticsLogEntry[] = [];
    const local = { current: structuredClone(data) };
    core.setStorageAdapter({ getData: async () => structuredClone(local.current), saveData: async (next) => { local.current = structuredClone(next); } });
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
        localData: () => ({ getData: async () => structuredClone(local.current), saveData: async (next) => { local.current = structuredClone(next); } }),
        networkState: () => ({ isConnected: true, isInternetReachable: true }),
        appendLog: async (entry) => { entries.push(entry); return null; },
        translate: (key) => key,
        emit: () => undefined,
        trace: () => undefined,
        scheduleBackgroundSync: () => undefined,
        isFossBuild: false,
    });
    const cycleLine = () => entries.filter((entry) => entry.message === 'Native Android File Sync cycle').map((entry) => entry.context);
    const logged = (message: string) => entries.filter((entry) => entry.message === message);
    const contract = async () => {
        const opened = core.createNativeHostContract({ syncSettings: sync.settingsHost });
        expect(await opened.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        expect((await opened.openSyncSettings()).ok).toBe(true);
        return opened;
    };
    const attachmentOf = (id: string) => [...local.current.tasks, ...local.current.projects]
        .flatMap((item) => item.attachments ?? []).find((attachment) => attachment.id === id);
    return { sync, entries, cycleLine, logged, kv, secrets, local, contract, attachmentOf };
};

const fileHost = (data?: AppData, path = ROOT) => host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: path }, data);
const manual = { manual: true } as const;
const PASS = 'correct horse battery staple';
/** Another device synced the folder and turned encryption on there; this process then starts as a fresh device. */
const encryptedByPeer = async (data?: AppData) => {
    const peer = fileHost(data);
    expect(await peer.sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
    await peer.sync.settingsHost.encryption.transitions!.enable(PASS, {});
    await core.flushPendingSave().catch(() => undefined);
    resetForTests();
    setLogger(() => undefined);
};
const writes = (ops: string[]) => ops.filter((op) => /^(write|delete|createFile|makeDirectory|rename) /.test(op));

/**
 * One File attachment pass (core's syncFileAttachments) as createNativeSync binds it: host-attachments.ts over the SAF port, the
 * app's files and the installer, with sync's encryption material. RN's tests drive the same pass (attachment-sync.test.ts).
 */
const pass = (folder: ReturnType<typeof provider>, app: ReturnType<typeof appFiles>, material: core.SyncKeyMaterial | null = null) => {
    const kv = new Map<string, string>();
    const lines: { message: string; extra?: Record<string, unknown> }[] = [];
    const record = (message: string, context?: { extra?: Record<string, unknown> }) => { lines.push({ message, extra: context?.extra }); };
    const native = createNativeAttachments({
        storage: { getItem: async (key) => kv.get(key) ?? null, setItem: async (key, value) => { kv.set(key, value); }, removeItem: async (key) => { kv.delete(key); } },
        getSecureConfigValue: async () => null,
        log: { info: record, warn: record, sanitize: (message) => message },
        crypto: createHostSyncCrypto(cryptoCall),
        saf: createHostSafPort(folder.call),
        encryption: { getSyncEncryptionMaterial: async () => material, logSyncEncryptionEvent: async () => undefined },
    }, { files: app.files, installer: app.installer, directories: { document: DOCUMENTS, cache: CACHE }, deleteNow: app.native.fileDeleteNow });
    const run = async (data: AppData, options: { activationProbe?: boolean; phase?: 'prepare' | 'post-merge' } = { phase: 'post-merge' }) => {
        const result = await native.syncPort.syncFile(data, folder.root, new AbortController().signal,
            { activationProbe: false, ...options, ...(material ? { material } : {}) });
        return result === false ? data : result as AppData;
    };
    return { run, lines, kv };
};
const one = (data: AppData) => data.tasks[0].attachments![0];
const withAttachments = (...attachments: Attachment[]): AppData => ({ tasks: [task('t1', 'mine', attachments)], projects: [], sections: [], areas: [], settings: {} });

afterEach(async () => {
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    await core.flushPendingSave().catch(() => undefined);
    globalThis.setTimeout = originalSetTimeout;
    resetForTests();
    setLogger(() => undefined);
    core.setSha256HexProvider(null);
    for (const name of channelGlobals) {
        const original = originalGlobals.get(name);
        if (original === undefined) delete globals[name];
        else globals[name] = original;
    }
});

describe('native Android File Sync: RN fix history through the native binding', () => {
    describe('attachment uploads through the SAF port (P3-4)', () => {
        it('uploads a new attachment into the folder\'s attachments/ through a SAF create and write', async () => {
            const { folder, app } = install();
            const bytes = text('attachment bytes');
            app.memory.put(`${MANAGED}a1.txt`, bytes);
            const { sync, attachmentOf } = fileHost({ tasks: [task('t1', 'mine', [fileAttachment('a1')])], projects: [], sections: [], areas: [], settings: {} });
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            const key = attachmentOf('a1')?.cloudKey;
            expect(key).toBe(`attachments/a1.${digest(bytes)}.txt`);
            expect(folder.ops).toContain(`createFile ${key!.slice('attachments/'.length)}`);
            expect(folder.ops).toContain(`write ${key!.slice('attachments/'.length)}`);
            expect(folder.read(key!)).toEqual(bytes);
        });

        it('deletes its own created document through the SAF port when the write fails', async () => {
            const { folder, app } = install();
            const bytes = text('attachment bytes');
            app.memory.put(`${MANAGED}a1.txt`, bytes);
            const name = `a1.${digest(bytes)}.txt`;
            folder.fail('write', new Error('SAF_DOCUMENT_UNAVAILABLE: provider refused the write'), name);
            const { sync, attachmentOf } = fileHost({ tasks: [task('t1', 'mine', [fileAttachment('a1')])], projects: [], sections: [], areas: [], settings: {} });
            await sync.settingsHost.performSync(undefined, manual);
            expect(folder.ops).toContain(`createFile ${name}`);
            expect(folder.ops).toContain(`delete ${name}`);
            expect(folder.names('attachments')).toEqual([]);
            expect(attachmentOf('a1')?.cloudKey).toBeUndefined();
        });
    });

    describe('the SAF attachment pass', () => {
        // 135 (download half), 164: pending bytes the folder holds come back through the host's stage copy, never a JS read.
        it('restores matching pending SAF bytes through the host\'s stage copy, without reading them into the engine (164)', async () => {
            const { folder, app } = install();
            const bytes = text('recovered');
            folder.put('attachments/a1.txt', bytes);
            const data = withAttachments(fileAttachment('a1', { cloudKey: 'attachments/a1.txt', fileHash: digest(bytes), pendingContentUpload: true, localStatus: 'missing' }));
            const result = one(await pass(folder, app).run(data));
            expect(result).toMatchObject({ uri: `${MANAGED}a1.txt`, localStatus: 'available' });
            expect(result.pendingContentUpload).toBeUndefined();
            expect(app.calls).toContain('copy content');
            expect(app.calls.filter((call) => call === 'readBytes content')).toEqual([]);
            expect(folder.ops.filter((op) => op.startsWith('read '))).toEqual([]);
            expect(app.installs).toEqual(['absent attachments/a1.txt']);
            expect(app.memory.read(`${MANAGED}a1.txt`)).toEqual(bytes);
        });

        // 135 (download half), 165: a remote winner installs over the exact stale local generation it replaces.
        it('installs a SAF remote winner over the exact stale local generation (165)', async () => {
            const { folder, app } = install();
            const stale = text('stale');
            const winner = text('winner');
            app.memory.put(`${MANAGED}a2.txt`, stale);
            folder.put('attachments/a2.txt', winner);
            const data = withAttachments(fileAttachment('a2', { cloudKey: 'attachments/a2.txt', fileHash: digest(winner), contentRev: 2 }));
            const result = one(await pass(folder, app).run(data));
            expect(app.installs).toEqual(['present attachments/a2.txt']);
            expect(app.memory.read(`${MANAGED}a2.txt`)).toEqual(winner);
            expect(result).toMatchObject({ fileHash: digest(winner), localStatus: 'available' });
            expect(folder.ops.filter((op) => op.startsWith('read '))).toEqual([]);
        });

        it('never adopts a file at the download target whose hash differs: the folder\'s bytes are staged and the installer decides (118)', async () => {
            const { folder, app } = install();
            const remote = text('remote');
            const other = text('someone else');
            folder.put('attachments/a3.txt', remote);
            app.memory.put(`${MANAGED}a3.txt`, other);
            const data = withAttachments(fileAttachment('a3', { uri: '', cloudKey: 'attachments/a3.txt', fileHash: digest(remote), pendingContentUpload: true, localStatus: 'missing' }));
            const result = one(await pass(folder, app).run(data));
            expect(app.calls).toContain('copy content');
            expect(app.installs).toEqual(['absent attachments/a3.txt']);
            // The other file is kept and never taken for the attachment.
            expect(app.memory.read(`${MANAGED}a3.txt`)).toEqual(other);
            expect(result.localStatus).not.toBe('available');
        });

        it('fails closed on a crash-left partial SAF generation without writing or deleting either generation (161)', async () => {
            const { folder, app } = install();
            const mine = text('generation one');
            const theirs = text('generation two');
            app.memory.put(`${MANAGED}a4.txt`, mine);
            const partial = `attachments/a4.${digest(mine)}.txt`;
            const valid = `attachments/a4.${digest(theirs)}.txt`;
            folder.put(partial, new Uint8Array([81]));
            folder.put(valid, theirs);
            const data = withAttachments(fileAttachment('a4'));
            const result = one(await pass(folder, app).run(data));
            expect(result.cloudKey).toBeUndefined();
            expect(folder.read(partial)).toEqual(new Uint8Array([81]));
            expect(folder.read(valid)).toEqual(theirs);
            expect(folder.ops.filter((op) => /^(write|delete|createFile|rename) /.test(op))).toEqual([]);
        });

        it('reads the attachments/ listing once per pass (199)', async () => {
            const { folder, app } = install();
            for (const id of ['a5', 'a6']) {
                app.memory.put(`${MANAGED}${id}.txt`, text(id));
                folder.put(`attachments/${id}.txt`, text(id));
            }
            const data = withAttachments(fileAttachment('a5', { cloudKey: 'attachments/a5.txt' }), fileAttachment('a6', { cloudKey: 'attachments/a6.txt' }));
            await pass(folder, app).run(data);
            expect(folder.ops.filter((op) => op === 'listChildren attachments')).toEqual(['listChildren attachments']);
        });

        it('makes no SAF create for an attachment over the File Sync bound (152)', async () => {
            const { folder, app } = install();
            app.memory.put(`${MANAGED}a7.txt`, text('big'));
            app.sizes.set(`${MANAGED}a7.txt`, core.MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES + 1);
            const data = withAttachments(fileAttachment('a7', { size: core.MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES + 1 }));
            const outcome = await pass(folder, app).run(data).then(one, (error: unknown) => error);
            expect(folder.ops.filter((op) => op.startsWith('createFile') || op.startsWith('write'))).toEqual([]);
            expect(outcome).toBeInstanceOf(core.AttachmentUploadTooLargeError);
        });

        it('a plaintext device meeting an encrypted attachment in the folder fails its fetch closed and installs nothing (129)', async () => {
            const { folder, app } = install();
            const material = await core.deriveSyncKeyMaterial(PASS, new Uint8Array(16).fill(3), { mKib: 8, t: 1, p: 1 }, createHostSyncCrypto(cryptoCall));
            folder.put('attachments/r1.txt', await core.encryptSyncArtifact(text('sealed by a peer'), material));
            const { sync, logged } = fileHost();
            const outcome = await sync.attachmentsHost!.ensureAttachmentAvailableDetailed(
                fileAttachment('r1', { uri: '', cloudKey: 'attachments/r1.txt', localStatus: 'missing' }));
            expect(outcome).not.toMatchObject({ status: 'available' });
            expect(app.calls).toContain('copy content');
            expect([...app.memory.files.keys()].filter((uri) => uri.startsWith(MANAGED))).toEqual([]);
            expect(writes(folder.ops)).toEqual(writes(folder.ops).filter((op) => op.startsWith('makeDirectory')));
            expect(logged('[sync-encryption] remote-read').some((entry) => entry.context?.decision === 'no-key')).toBe(true);
        });

        it('keeps the key of an absent SAF blob during activation so core can defer it (143)', async () => {
            const { folder, app } = install();
            folder.put('attachments/other.txt', text('other'));
            const data = withAttachments(fileAttachment('absent-blob', { uri: '', cloudKey: 'attachments/absent-blob.pdf', localStatus: 'missing' }));
            const { run, lines } = pass(folder, app);
            const result = one(await run(data, { activationProbe: true, phase: 'post-merge' }));
            expect(result).toMatchObject({ cloudKey: 'attachments/absent-blob.pdf', localStatus: 'missing' });
            expect(lines).toContainEqual(expect.objectContaining({
                message: 'File Sync activation left an attachment the folder does not hold yet',
                extra: expect.objectContaining({ releaseCheck: 'v1.3.0/mobile-file-activation-absent-blob' }),
            }));
        });
    });

    describe('encryption transitions on the folder lease', () => {
        it('a held lease makes an enable report busy and change nothing, as it does a cycle (35)', async () => {
            const { folder, folderLock } = install();
            const { sync } = fileHost();
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            const before = folder.ops.length;
            const names = folder.names();
            folderLock.hold();
            const failure = await sync.settingsHost.encryption.transitions!.enable(PASS, {}).then(() => null, (error: unknown) => error);
            expect(failure).toBeInstanceOf(core.SyncFileLockBusyError);
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ skipped: 'fileSyncLockBusy' });
            expect(writes(folder.ops.slice(before))).toEqual([]);
            expect(folder.names()).toEqual(names);
            expect(await sync.settingsHost.encryption.getStatus()).toMatchObject({ state: 'off' });
        });

        it('with a File folder stored, a keyless device unlocks the folder another device encrypted (120)', async () => {
            const { folder } = install();
            await encryptedByPeer();
            const { sync } = fileHost();
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: false });
            expect(await sync.settingsHost.encryption.transitions!.provide(PASS)).toBe('ok');
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            expect(await sync.settingsHost.encryption.getStatus()).toMatchObject({ state: 'enabled' });
            expect(folder.names()).toContain('data.json.enc');
            expect(folder.names()).not.toContain('data.json');
        });

        it('a lease release that fails after a committed enable reports cleanup deferred and keeps the enable (170)', async () => {
            const { folder, folderLock } = install();
            const { sync } = fileHost();
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            const cleanupError = new Error('native lock release failed');
            folderLock.failRelease(cleanupError);
            const failure = await sync.settingsHost.encryption.transitions!.enable(PASS, {}).then(() => null, (error: unknown) => error);
            expect(failure).toBeInstanceOf(core.SyncEncryptionCleanupDeferredError);
            expect(failure).toMatchObject({ cleanupKind: 'file-lock' });
            expect(await sync.settingsHost.encryption.getStatus()).toMatchObject({ state: 'enabled' });
            expect(folder.names()).toEqual(['data.json.enc']);
        });

        it('an identity-lost release after an enable rolls the material back to the journal (171)', async () => {
            const { folderLock } = install();
            const { sync, secrets } = fileHost();
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            folderLock.failRelease(new Error('SYNC_FILE_LOCK_IDENTITY_LOST: private SAF authority changed'));
            const failure = await sync.settingsHost.encryption.transitions!.enable(PASS, {}).then(() => null, (error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(await sync.settingsHost.encryption.getStatus()).toEqual({ state: 'off', incompleteTransition: 'enable' });
            expect([...secrets.keys()].filter((key) => /encryption/i.test(key))).toEqual([]);
        });

        it('a second host on the same storage refuses the File cycle while a transition journal exists, with no document read or write (182)', async () => {
            const { folder } = install();
            const first = fileHost();
            await first.sync.settingsHost.encryption.getStatus();
            first.kv.set(core.SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', incompleteTransition: 'enable' }));
            const second = host({}, undefined, { kv: first.kv, secrets: first.secrets });
            expect(await second.sync.settingsHost.encryption.getStatus()).toEqual({ state: 'off', incompleteTransition: 'enable' });
            expect(await second.sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: false });
            // RN pins no document read or write (sync-service.runtime.test.ts); resolving the folder's path lists it first.
            expect(folder.ops.filter((op) => !op.startsWith('listChildren '))).toEqual([]);
        });

        it('unreadable encryption state: the cycle fails with no document read or write (188)', async () => {
            const { folder } = install();
            const { sync, kv } = fileHost();
            kv.set(core.SYNC_ENCRYPTION_STATE_KEY, '{"state": "enab');
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: false });
            expect(folder.ops.filter((op) => !op.startsWith('listChildren '))).toEqual([]);
        });
    });

    describe('attachments through File cycles', () => {
        it('a fresh device joining an encrypted folder uploads no attachment before the folder\'s posture is known (146)', async () => {
            const { folder, app } = install();
            await encryptedByPeer();
            app.memory.put(`${MANAGED}a1.txt`, text('plaintext attachment'));
            const { sync } = fileHost(withAttachments(fileAttachment('a1')));
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: false });
            expect(folder.names()).toEqual(['data.json.enc']);
            expect(writes(folder.ops)).toEqual(writes(folder.ops).filter((op) => !op.includes('a1')));
            expect(folder.ops.some((op) => op.includes('attachments'))).toBe(false);
        });

        it('a File cleanup run deletes nothing under attachments/ (158)', async () => {
            const { folder, app } = install();
            const bytes = text('removed attachment');
            app.memory.put(`${MANAGED}d1.txt`, bytes);
            folder.put('attachments/d1.txt', bytes);
            const { sync, logged } = fileHost(withAttachments(fileAttachment('d1', { cloudKey: 'attachments/d1.txt', deletedAt: DATE })));
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            expect(folder.read('attachments/d1.txt')).toEqual(bytes);
            expect(folder.ops.filter((op) => op.startsWith('delete d1'))).toEqual([]);
            // The cleanup ran: the local copy is gone.
            expect(app.memory.read(`${MANAGED}d1.txt`)).toBeUndefined();
            expect(logged('Attachment cleanup freshness guarded').length).toBeGreaterThan(0);
        });

        it('a SAF attachment generation with wrong bytes refuses the folder\'s activation (154)', async () => {
            const { folder, app, picked } = install();
            const bytes = text('mine');
            app.memory.put(`${MANAGED}a1.txt`, bytes);
            folder.put(`attachments/a1.${digest(bytes)}.txt`, text('not mine'));
            picked(folder.tree);
            const { contract, kv } = host({ [SYNC_BACKEND_KEY]: 'file' }, withAttachments(fileAttachment('a1')));
            const result = await (await contract()).pickSyncFolder({ requestId: core.generateUUID() });
            if (!result.ok) throw new Error(result.error.message);
            expect(result.value.toasts).toEqual([expect.objectContaining({ tone: 'error' })]);
            expect(kv.get(SYNC_PATH_KEY)).toBeUndefined();
        });

        it('activating a new folder reads that folder, not the stored one (128)', async () => {
            const { folder, others, picked } = install({ others: ['Old'] });
            const old = others.get('Old')!;
            old.put('data.json.enc', text('MWENC1 ciphertext a peer left'));
            picked(folder.tree);
            const { contract, kv } = host({ [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: old.root });
            const opened = await contract();
            const before = old.ops.length;
            const result = await opened.pickSyncFolder({ requestId: core.generateUUID() });
            if (!result.ok) throw new Error(result.error.message);
            expect(result.value.toasts.filter((toast) => toast.tone === 'error')).toEqual([]);
            expect(kv.get(SYNC_PATH_KEY)).toBe(folder.uriOf('data.json'));
            expect(old.ops.slice(before)).toEqual([]);
            expect(folder.ops).toContain('listChildren /');
        });
    });

    it('after an aborted File cycle, a new lease is granted at once (144)', async () => {
        const { folder, folderLock, app } = install();
        app.memory.put(`${MANAGED}a1.txt`, text('attachment bytes'));
        const create = folder.pause('createFile', 'a1.');
        const { sync, cycleLine, logged } = fileHost(withAttachments(fileAttachment('a1')));
        sync.start('active');
        await create.at;
        expect(folderLock.held.size).toBe(1);
        // The app leaves while the cycle uploads an attachment: the triggers abort it (RN's lifecycle abort).
        sync.appState('background');
        create.release();
        for (let tries = 0; tries < 200 && cycleLine().length === 0; tries += 1) await new Promise((resolve) => originalSetTimeout(resolve, 5));
        // Core answers a lifecycle abort as a success that queues a follow-up.
        expect(logged('Sync aborted by app lifecycle transition').length).toBe(1);
        expect(cycleLine().length).toBe(1);
        expect(folderLock.held.size).toBe(0);
        // The aborted upload left nothing behind.
        expect(folder.names('attachments')).toEqual([]);
        for (const handle of timers) clearTimeout(handle);
        sync.appState('active');
        const acquires = folderLock.calls.filter((op) => op === 'acquire').length;
        expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
        expect(folderLock.calls.filter((op) => op === 'acquire').length).toBeGreaterThan(acquires);
    });

    it('busy lease, its retry, then an ordinary follow-up: the contention retry budget is restored (168)', async () => {
        const { folder, folderLock } = install();
        // Core's follow-up waits (5 s for a busy lease, 1 s and more otherwise) run at once here.
        const tracked = globalThis.setTimeout;
        globalThis.setTimeout = ((run: () => void, _delay?: number) => tracked(run, 0)) as typeof setTimeout;
        folderLock.script.push('busy', 'grant', 'busy', 'grant');
        // The retry's cycle meets an edit made while it read the folder: core queues an ordinary follow-up.
        folder.when('read', () => core.useTaskStore.setState({ lastDataChangeAt: Date.now() + 60_000 }));
        const { sync } = fileHost();
        expect(await sync.settingsHost.performSync(undefined, {})).toMatchObject({ success: true, fileSyncLockDeferred: 'busy' });
        const count = (op: string) => folderLock.calls.filter((call) => call === op).length;
        for (let tries = 0; tries < 400 && (count('acquire') < 4 || count('release') < 2); tries += 1) {
            await new Promise((resolve) => originalSetTimeout(resolve, 5));
        }
        expect(count('acquire')).toBe(4);
        expect(count('release')).toBe(2);
    });

    it('an overlapping requeued sync neither drops nor logs the running cycle\'s line (P3-5)', async () => {
        const { folder } = install();
        const write = folder.pause('write');
        const { sync, cycleLine } = fileHost();
        const running = sync.settingsHost.performSync(undefined, manual);
        await write.at;
        // Core answers an activation probe that overlaps a running cycle with a requeue, at once.
        expect(await sync.settingsHost.performSync(undefined, { activationProbe: true })).toMatchObject({ skipped: 'requeued' });
        expect(cycleLine()).toEqual([]);
        write.release(new Error('SAF_DOCUMENT_UNAVAILABLE: the provider went away'));
        expect(await running).toMatchObject({ success: false });
        expect(cycleLine()).toEqual([expect.objectContaining({ outcome: 'failed', provider: AUTHORITY })]);
    });

    it('a host without attachment channels still hashes: an enable needs SHA-256 and the engine has no WebCrypto (P3-12)', async () => {
        const { folder } = install({ files: false });
        // The engine's crypto (host-polyfills.js): random bytes only.
        const webCrypto = globalThis.crypto;
        globalThis.crypto = { getRandomValues: <T extends ArrayBufferView>(array: T) => webCrypto.getRandomValues(array as never) } as unknown as Crypto;
        try {
            const { sync } = fileHost();
            expect(await sync.settingsHost.performSync(undefined, manual)).toMatchObject({ success: true });
            await sync.settingsHost.encryption.transitions!.enable(PASS, {});
            expect(folder.names()).toEqual(['data.json.enc']);
        } finally {
            globalThis.crypto = webCrypto;
        }
    });
});
