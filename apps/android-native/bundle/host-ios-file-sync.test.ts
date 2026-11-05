import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { base64ToBytes, bytesToBase64, FILE_SYNC_ABSENT_FINGERPRINT, FileSyncPathOwnerTerminatedError, type AppData, type Attachment, type MobileFileSyncFullHost } from '@mindwtr/core';
import { createNativeFileSync, prepareNativeFileSync, type NativeFileSyncCall } from './host-file-sync';
import { createNativeAttachments, type NativeFileChannels } from './host-attachments';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import { setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
import { buildFileSyncGenerationCloudKey } from '../../../packages/core/src/attachment-paths';
import { defaultSyncCryptoPrimitives, encryptSyncArtifact, SYNC_CRYPTO_DEFAULT_KDF_PARAMS } from '../../../packages/core/src/sync-crypto';
import { SyncEncryptionPartlyEncryptedError } from '../../../packages/core/src/sync-encryption';
const selection = { turn: 'one-turn', rootURI: 'file:///app/Sync%20%E8%B3%87%E6%96%99/', canonicalPath: 'file:///app/Sync%20%E8%B3%87%E6%96%99/data.json' };
const host: Pick<MobileFileSyncFullHost, 'encryption' | 'crypto' | 'log'> = {
    encryption: { localState: { read: () => null, write: () => {} }, flush: async () => {}, logEvent: () => {} },
    crypto: { randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)), argon2id: async () => { throw new Error('unsupported'); },
        aesGcmOpen: async () => { throw new Error('unsupported'); }, aesGcmSeal: async () => { throw new Error('unsupported'); } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
};
const original = globalThis.fetch;
const browserBase64 = ['atob', 'btoa'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const withoutBrowserBase64 = () => { for (const [name] of browserBase64) Reflect.deleteProperty(globalThis, name); };
afterEach(() => {
    globalThis.fetch = original;
    for (const [name, descriptor] of browserBase64) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});
it('opens, revalidates and closes the same sole transport turn', async () => {
    const calls: Record<string, unknown>[] = [];
    const port = createNativeFileSync(selection, async (request) => { calls.push(request); return { id: 'reply', value: null }; }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await port.revalidateLease(lease); await port.releaseLease(lease);
    expect(calls).toEqual(['open', 'revalidate', 'close'].map((op) => ({ turn: selection.turn, op })));
    await expect(port.revalidateLease(lease)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((call) => call.op === 'open')).toHaveLength(1);
});
it.each([{ exists: undefined }, { exists: null }, { exists: 0 }, { exists: true }, { exists: false, size: 1 }])('unknown metadata %j ends the actual versioned-read path and awaits close', async (info) => {
    const calls: string[] = [];
    let release!: () => void, reached!: () => void;
    const closing = new Promise<void>((resolve) => { reached = resolve; });
    const closed = new Promise<void>((resolve) => { release = resolve; });
    const call: NativeFileSyncCall = async (request) => {
        calls.push(String(request.op));
        if (request.op === 'close') { reached(); await closed; return { id: 'close', value: null }; }
        return { id: 'reply', value: request.op === 'info' ? info : request.op === 'list' ? [] : null };
    };
    const port = createNativeFileSync(selection, call, host);
    await port.acquireLease(selection.canonicalPath);
    let settled = false;
    const pending = port.readVersioned(selection.canonicalPath, {}).finally(() => { settled = true; });
    await closing;
    expect(calls).toContain('close'); expect(settled).toBe(false);
    release(); await expect(pending).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'info')).toHaveLength(1);
    expect(calls.filter((op) => op === 'list').length).toBeGreaterThan(0);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
    expect(calls.every((op) => ['open', 'list', 'info', 'close'].includes(op))).toBe(true);
});
it('foreign lease token retires the current capability without another open', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => { calls.push(String(request.op)); return { id: 'reply', value: null }; }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.revalidateLease({ turn: 'foreign' })).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    await expect(port.revalidateLease({ turn: selection.turn })).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls).toEqual(['open', 'close', 'close']);
});
it('a native terminal error cannot turn its error text into absence or a later request', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        return request.op === 'info' ? { id: 'reply', error: 'ENOENT data.json' } : { id: 'reply', value: request.op === 'list' ? [] : null };
    }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await expect(port.readVersioned(selection.canonicalPath, {})).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    await expect(port.revalidateLease(lease)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => !['open', 'list', 'info', 'close'].includes(op))).toEqual([]);
});

it('noncanonical returned base64 fails the actual versioned read before any fallback', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: [] };
        if (request.op === 'info') return { id: 'reply', value: { exists: true, size: 1 } };
        if (request.op === 'read') return { id: 'reply', value: 'bytes', body: true, base64: 'Zg==\n' };
        return { id: 'reply', value: null };
    }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.readVersioned(selection.canonicalPath, {})).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'read')).toHaveLength(1);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
});

it('reads a complete versioned document without browser base64 globals', async () => {
    const data: AppData = { tasks: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Synthetic remote', status: 'inbox',
        tags: [], contexts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    projects: [], sections: [], areas: [], settings: {} };
    const bytes = new TextEncoder().encode(JSON.stringify(data)), encoded = bytesToBase64(bytes), calls: string[] = [];
    withoutBrowserBase64();
    expect(typeof globalThis.atob).toBe('undefined'); expect(typeof globalThis.btoa).toBe('undefined');
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: ['data.json'] };
        if (request.op === 'info') return { id: 'reply', value: request.uri === selection.canonicalPath ? { exists: true, size: bytes.length } : { exists: false } };
        if (request.op === 'read') return { id: 'reply', value: 'bytes', body: true, base64: encoded };
        return { id: 'reply', value: null };
    }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    const result = await port.readVersioned(selection.canonicalPath, {});
    expect(result.source).toBe('primary'); expect(result.data.tasks.map((task) => task.id)).toEqual(data.tasks.map((task) => task.id));
    expect(result.fingerprint).toBe(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}:length=${bytes.length}`);
    expect(calls.filter((op) => op === 'read')).toHaveLength(1);
    await port.releaseLease(lease);
});
it('encodes the actual observed write call without browser base64 globals', async () => {
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    const calls: string[] = [];
    let encoded: unknown;
    withoutBrowserBase64();
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: [] };
        if (request.op === 'info') return { id: 'reply', value: { exists: false } };
        if (request.op === 'read') return { id: 'reply', value: 'absent' };
        if (request.op === 'create') return { id: 'reply', value: 'created' };
        if (request.op === 'writeCreated') {
            encoded = request.base64;
            throw new Error('Selected transport refusal after encoded bytes');
        }
        return { id: 'reply', value: null };
    }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.write(selection.canonicalPath, data, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT }))
        .rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'writeCreated')).toHaveLength(1);
    expect(typeof encoded).toBe('string');
    const expected = new TextEncoder().encode(JSON.stringify(data, null, 2));
    expect(encoded).toBe(bytesToBase64(expected));
    expect(base64ToBytes(String(encoded))).toEqual(expected);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
});

it('prepares the owner projection then adopts that same turn without resolving a bookmark in JS', async () => {
    const calls: Record<string, unknown>[] = [];
    const call: NativeFileSyncCall = async (request) => {
        calls.push(request);
        return { id: 'reply', value: request.op === 'prepare' ? { rootURI: selection.rootURI, canonicalPath: selection.canonicalPath } : null };
    };
    const resolved = await prepareNativeFileSync(selection.turn, call, host.log);
    const port = createNativeFileSync(resolved, call, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await port.releaseLease(lease);
    expect(calls).toEqual(['prepare', 'open', 'close'].map((op) => ({ turn: selection.turn, op })));
});
it.each([
    { rootURI: selection.rootURI, canonicalPath: selection.canonicalPath, bookmark: 'untrusted' },
    { rootURI: selection.rootURI, canonicalPath: selection.rootURI + 'peer.json' },
    { rootURI: 'https://private.invalid/', canonicalPath: 'https://private.invalid/data.json' },
])('refuses an invalid owner projection before acquiring IO: %j', async (value) => {
    const calls: string[] = [];
    await expect(prepareNativeFileSync(selection.turn, async (request) => {
        calls.push(String(request.op)); return { id: 'reply', value };
    }, host.log)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls).toEqual(['prepare']);
});

describe('File Sync attachments in the selected folder', () => {
    const FOLDER = `${selection.rootURI}attachments/`;
    const DATE = '2026-11-04T00:00:00.000Z';
    const LOCAL_URI = `${MANAGED}att-1.txt`;
    const LOCAL = new TextEncoder().encode('local attachment bytes');
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const fileAttachment = (fields: Partial<Attachment> = {}): Attachment => ({
        id: 'att-1', kind: 'file', title: 'notes.txt', uri: LOCAL_URI, createdAt: DATE, updatedAt: DATE, ...fields,
    });
    const linkAttachment: Attachment = { id: 'link-1', kind: 'link', title: 'Docs', uri: 'https://example.invalid/docs', createdAt: DATE, updatedAt: DATE };
    const withAttachments = (...attachments: Attachment[]): AppData => ({
        tasks: [{ id: 't1', title: 'Task', status: 'inbox', tags: [], contexts: [], createdAt: DATE, updatedAt: DATE, attachments }],
        projects: [], sections: [], areas: [], settings: {},
    });
    const attachmentOf = (data: AppData | boolean | null | undefined, id = 'att-1') => (data && typeof data === 'object'
        ? data.tasks.flatMap((task) => task.attachments ?? []).find((attachment) => attachment.id === id) : undefined);

    afterEach(() => setSha256HexProvider(null));

    const setup = (options: { storage?: ReturnType<typeof createMemoryStorage>; folder?: Map<string, Uint8Array>; fail?: (op: string) => boolean } = {}) => {
        const memory = createMemoryFileSystem({ sha256: async (bytes) => sha(bytes) });
        const folder = options.folder ?? new Map<string, Uint8Array>();
        const directories = new Set<string>();
        const ops: string[] = [];
        let inode = 10;
        const identities = new Map<string, string>();
        const reply = (value: unknown, extra: Record<string, unknown> = {}) => ({ id: 'reply', value, ...extra });
        const name = (uri: unknown) => String(uri).slice(FOLDER.length).replace(/\/$/, '');
        const call: NativeFileSyncCall = async (request) => {
            const op = String(request.op);
            ops.push(op);
            if (options.fail?.(op)) return { id: 'reply', error: 'FILE_SYNC_PATH_OWNER_TERMINATED' };
            const leaf = name(request.uri);
            switch (op) {
                case 'open': case 'revalidate': case 'close': return reply(null);
                case 'attachmentDirectory': directories.add(''); return reply(null);
                case 'attachmentInfo': {
                    if (leaf === '' || directories.has(leaf)) return reply({ exists: true, isDirectory: true, size: 0, modificationTime: 1 });
                    const bytes = folder.get(leaf);
                    return reply(bytes ? { exists: true, isDirectory: false, size: bytes.byteLength, modificationTime: 1 } : { exists: false });
                }
                case 'attachmentList': return reply([...new Set([...folder.keys()].filter((key) => !key.includes('/')).concat(
                    [...directories].filter((dir) => dir && !dir.includes('/'))))]);
                case 'attachmentRead': {
                    const bytes = folder.get(leaf);
                    if (!bytes) return reply('absent');
                    if (request.length === null && bytes.byteLength > 8 * 1024 * 1024) return reply('tooLarge');
                    const start = Number(request.position);
                    const slice = request.length === null ? bytes.slice(start) : bytes.slice(start, start + Number(request.length));
                    return reply('bytes', { body: true, base64: bytesToBase64(slice) });
                }
                case 'attachmentPrepare': {
                    const stage = `.mindwtr-install-${String(request.operationId)}.candidate`;
                    directories.add(stage);
                    folder.set(`${stage}/stage`, new Uint8Array());
                    identities.set(`${stage}/stage`, `1:${inode += 1}`);
                    return reply({ stagedIdentity: identities.get(`${stage}/stage`), directoryIdentity: '1:2', privateDirectoryIdentity: `1:${inode += 1}` });
                }
                case 'attachmentWrite': folder.set(leaf, base64ToBytes(String(request.base64))); return reply(null);
                case 'attachmentSnapshot': return reply({ stagedIdentity: identities.get(leaf), directoryIdentity: '1:2' });
                case 'attachmentPublish': {
                    const target = name(request.target);
                    if (folder.has(target)) return reply('alreadyExists');
                    folder.set(target, folder.get(leaf)!);
                    folder.delete(leaf);
                    directories.delete(leaf.split('/')[0]);
                    return reply('published');
                }
                case 'attachmentCleanup': {
                    const existed = folder.delete(leaf);
                    directories.delete(leaf.split('/')[0]);
                    return reply(existed ? 'removed' : 'missing');
                }
                default: throw new Error(`Unexpected native op ${op}`);
            }
        };
        const channels: NativeFileChannels = {
            directories: { document: DOCUMENTS, cache: CACHE },
            files: async (request, bytes) => {
                const uri = String(request.uri ?? '');
                switch (request.op) {
                    case 'barrier': case 'syncParent': return null;
                    case 'sha256': return sha(bytes!);
                    case 'sha256File': return sha(memory.read(uri)!);
                    case 'getInfo': return memory.fs.getInfo(uri);
                    case 'makeDirectory': return memory.fs.makeDirectory(uri);
                    case 'readDirectory': return memory.fs.readDirectory(uri);
                    case 'readBytes': return memory.fs.readBytes(uri);
                    case 'readBytesRange': return memory.fs.readBytesRange(uri, Number(request.position), Number(request.length));
                    case 'writeBytes': return memory.fs.writeBytes(uri, bytes!);
                    case 'copy': return memory.fs.copy(uri, String(request.to));
                    case 'move': return memory.fs.move(uri, String(request.to));
                    case 'delete': return memory.fs.delete(uri);
                    default: throw new Error(`Unexpected local op ${String(request.op)}`);
                }
            },
            installer: async (request) => {
                if (request.op === 'hash') {
                    const bytes = memory.read(String(request.path))!;
                    return { sha256: sha(bytes), size: bytes.byteLength, modificationTimeMs: 1 };
                }
                if (request.op === 'install') {
                    const staged = memory.read(String(request.staged))!;
                    memory.put(String(request.target), staged);
                    memory.files.delete(String(request.staged));
                    return { status: 'installed' };
                }
                throw new Error('Unexpected installer op');
            },
            deleteNow: (uri) => { memory.files.delete(uri); },
        };
        const storage = options.storage ?? createMemoryStorage();
        const recorded = createRecordingLog();
        const port = createNativeFileSync(selection, call, host);
        const native = createNativeAttachments({
            storage: storage.storage, getSecureConfigValue: async () => null, log: recorded.log,
            crypto: defaultSyncCryptoPrimitives,
            encryption: { getSyncEncryptionMaterial: async () => null, logSyncEncryptionEvent: () => {} },
            fileSync: port.attachments,
        }, channels);
        return { memory, folder, ops, port, native, storage, lines: recorded.lines };
    };
    const sync = async (context: ReturnType<typeof setup>, data: AppData) => {
        const lease = await context.port.acquireLease(selection.canonicalPath);
        const result = await context.native.syncPort.syncFile(data, selection.canonicalPath, new AbortController().signal, { activationProbe: false });
        await context.port.releaseLease(lease);
        return result;
    };

    it('publishes a local file through the native journaled stage and records its generation key', async () => {
        const context = setup();
        context.memory.put(LOCAL_URI, LOCAL);
        const cloudKey = buildFileSyncGenerationCloudKey(fileAttachment(), sha(LOCAL));

        const result = await sync(context, withAttachments(fileAttachment(), linkAttachment));

        expect(attachmentOf(result)?.cloudKey).toBe(cloudKey);
        expect(attachmentOf(result, 'link-1')).toEqual(linkAttachment);
        expect(context.folder.get(cloudKey.split('/').pop()!)).toEqual(LOCAL);
        expect([...context.folder.keys()].some((key) => key.includes('.mindwtr-install-'))).toBe(false);
        expect(context.ops.filter((op) => op.startsWith('attachment') && op !== 'attachmentInfo' && op !== 'attachmentList' && op !== 'attachmentRead'))
            .toEqual(['attachmentDirectory', 'attachmentPrepare', 'attachmentWrite', 'attachmentSnapshot', 'attachmentPublish', 'attachmentCleanup']);
        expect(context.storage.values.get('@mindwtr/file-sync-publication-reservations-v1')).toBeUndefined();
        expect(context.lines).toContainEqual({ level: 'info', message: 'Native iOS File Sync attachment pass completed', extra: {
            releaseCheck: 'v1.3.9/ios-file-sync-attachments', phase: 'full', outcome: 'updated', published: '1', downloaded: '0' } });
    });

    it('a link row alone needs no folder transfer', async () => {
        const context = setup();
        const result = await sync(context, withAttachments(linkAttachment));
        expect(result).toBe(false);
        expect(context.ops.filter((op) => ['attachmentPrepare', 'attachmentWrite', 'attachmentRead'].includes(op))).toEqual([]);
    });

    it('downloads a generation another device published into the managed folder during the pass', async () => {
        const remote = new TextEncoder().encode('peer bytes');
        const cloudKey = buildFileSyncGenerationCloudKey(fileAttachment(), sha(remote));
        const context = setup({ folder: new Map([[cloudKey.split('/').pop()!, remote]]) });
        const missing = fileAttachment({ uri: '', cloudKey, fileHash: sha(remote), size: remote.byteLength, localStatus: 'missing' });

        const result = await sync(context, withAttachments(missing));

        expect(attachmentOf(result)?.localStatus).toBe('available');
        expect(attachmentOf(result)?.uri.startsWith(MANAGED)).toBe(true);
        expect(context.memory.read(attachmentOf(result)!.uri)).toEqual(remote);
        expect(context.ops).not.toContain('attachmentPrepare');
        expect(context.lines).toContainEqual(expect.objectContaining({ extra: expect.objectContaining({ downloaded: '1', published: '0' }) }));
    });

    it('reaches no folder operation before the lease opens', async () => {
        const context = setup();
        context.memory.put(LOCAL_URI, LOCAL);
        const result = await context.native.syncPort.syncFile(withAttachments(fileAttachment()), selection.canonicalPath, new AbortController().signal, { activationProbe: false });
        expect(attachmentOf(result === false ? withAttachments(fileAttachment()) : result)?.cloudKey).toBeUndefined();
        expect(context.ops).toEqual([]);
        expect(context.folder.size).toBe(0);
    });

    it('a device with encryption off writes nothing beside an attachment an interrupted enable sealed', async () => {
        const material = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
        const sealed = await encryptSyncArtifact(new TextEncoder().encode('peer attachment'), material, defaultSyncCryptoPrimitives);
        const context = setup({ folder: new Map([['peer.txt', sealed]]) });
        context.memory.put(LOCAL_URI, LOCAL);

        await expect(sync(context, withAttachments(fileAttachment()))).rejects.toBeInstanceOf(SyncEncryptionPartlyEncryptedError);

        expect(context.ops).not.toContain('attachmentPrepare');
        expect([...context.folder.keys()]).toEqual(['peer.txt']);
    });

    it('an interrupted stage write ends the owner, keeps its journal record and is retired before the next publication', async () => {
        const storage = createMemoryStorage();
        const first = setup({ storage, fail: (op) => op === 'attachmentWrite' });
        first.memory.put(LOCAL_URI, LOCAL);
        const lease = await first.port.acquireLease(selection.canonicalPath);
        const interrupted = await first.native.syncPort.syncFile(withAttachments(fileAttachment()), selection.canonicalPath, new AbortController().signal, { activationProbe: false });
        expect(attachmentOf(interrupted === false ? withAttachments(fileAttachment()) : interrupted)?.cloudKey).toBeUndefined();
        await expect(first.port.revalidateLease(lease)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(first.ops.slice(first.ops.indexOf('attachmentWrite') + 1).every((op) => op === 'close')).toBe(true);
        const journal = JSON.parse(storage.values.get('@mindwtr/file-sync-publication-reservations-v1')!) as { state: string; stagedPath: string }[];
        expect(journal).toHaveLength(1);
        expect(journal[0].state).toBe('reserved');
        expect(journal[0].stagedPath.startsWith(`${FOLDER}.mindwtr-install-`)).toBe(true);

        const second = setup({ storage, folder: first.folder });
        second.memory.put(LOCAL_URI, LOCAL);
        const result = await sync(second, withAttachments(fileAttachment()));

        expect(second.ops.indexOf('attachmentCleanup')).toBeLessThan(second.ops.indexOf('attachmentPrepare'));
        expect(attachmentOf(result)?.cloudKey).toBe(buildFileSyncGenerationCloudKey(fileAttachment(), sha(LOCAL)));
        expect([...second.folder.keys()].filter((key) => key.includes('.mindwtr-install-'))).toEqual([]);
        expect(storage.values.get('@mindwtr/file-sync-publication-reservations-v1')).toBeUndefined();
    });

    it('an attachment over the 8 MiB transfer limit fails only its own download', async () => {
        const remote = new Uint8Array(8 * 1024 * 1024 + 1);
        const cloudKey = buildFileSyncGenerationCloudKey(fileAttachment(), sha(remote));
        const context = setup({ folder: new Map([[cloudKey.split('/').pop()!, remote]]) });
        const missing = fileAttachment({ uri: '', cloudKey, size: remote.byteLength, localStatus: 'missing' });

        const result = await sync(context, withAttachments(missing));

        expect(attachmentOf(result === false ? withAttachments(missing) : result)?.localStatus).toBe('missing');
        expect(context.ops).toContain('attachmentRead');
        expect(context.ops.filter((op) => op === 'close')).toHaveLength(1);
        expect(context.ops.at(-1)).toBe('close');
    });

    it.each([
        ['attachmentInfo', { exists: true, size: 1 }],
        ['attachmentList', ['a/b']],
        ['attachmentPrepare', { stagedIdentity: 'x', directoryIdentity: '1:2', privateDirectoryIdentity: '1:3' }],
        ['attachmentPublish', 'replaced'],
    ])('an invalid %s answer ends the owner', async (op, value) => {
        const calls: string[] = [];
        const port = createNativeFileSync(selection, async (request) => {
            calls.push(String(request.op));
            return { id: 'reply', value: request.op === op ? value : null };
        }, host);
        await port.acquireLease(selection.canonicalPath);
        const files = port.attachments.channels({ directories: { document: DOCUMENTS, cache: CACHE },
            files: async () => { throw new Error('local'); }, installer: async () => null, deleteNow: () => {} }).files;
        const attempt = op === 'attachmentInfo' ? files({ op: 'getInfo', uri: `${FOLDER}x` })
            : op === 'attachmentList' ? files({ op: 'readDirectory', uri: FOLDER })
                : op === 'attachmentPrepare' ? port.attachments.immutable.prepareImmutableStageAsync(`${FOLDER}x`, 'a'.repeat(32))
                    : port.attachments.immutable.publishImmutableAsync(`${FOLDER}.mindwtr-install-${'a'.repeat(32)}.candidate/stage`, `${FOLDER}x`, 'a'.repeat(64), '1:1', '1:2', '1:3');
        await expect(attempt).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
        expect(calls.slice(-1)).toEqual(['close']);
    });
});
