import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    createNativeLocalAttachmentConfiguration,
    createNativeLocalAttachments,
    createNativeLocalAttachmentsForHost,
    type NativeFileChannels,
} from './host-attachments';
import { computeSha256Hex, setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import { openScreenHost, value } from '../../../packages/core/src/screen-parity.replay';
import { taskRevisionOf } from '../../../packages/core/src/native-request-receipts';
import { consoleLogger, setLogger } from '../../../packages/core/src/logger';
import { useTaskStore } from '../../../packages/core/src/store';
import * as keys from '../../../packages/core/src/sync-storage-keys';
import type { Attachment, Project, Task } from '../../../packages/core/src/types';

const globals = globalThis as typeof globalThis & Record<string, unknown>;
const DATE = '2026-10-04T00:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000215';
const attachment = (uri: string): Attachment => ({ id: ID, kind: 'file', title: 'fixture.txt', uri, createdAt: DATE, updatedAt: DATE });
const task = (attachments: Attachment[] = []): Task => ({ id: 'task215', title: 'Fixture', status: 'next', tags: [], contexts: [],
    attachments, createdAt: DATE, updatedAt: DATE });

const fixture = () => {
    const memory = createMemoryFileSystem();
    const calls: string[] = [];
    let barrier: (() => Promise<void>) | null = null;
    const channels: NativeFileChannels = {
        directories: { document: DOCUMENTS, cache: CACHE },
        files: async (request, bytes) => {
            const op = String(request.op);
            const uri = String(request.uri ?? '');
            calls.push(op);
            if (uri && !uri.startsWith(DOCUMENTS) && !uri.startsWith(CACHE)) throw new Error('Attachment file operation unavailable');
            switch (op) {
                case 'barrier': await barrier?.(); return null;
                case 'syncParent': return null;
                case 'sha256': return createHash('sha256').update(bytes!).digest('hex');
                case 'sha256File': return createHash('sha256').update(memory.read(uri)!).digest('hex');
                case 'getInfo': return memory.fs.getInfo(uri);
                case 'makeDirectory': return memory.fs.makeDirectory(uri);
                case 'readDirectory': return memory.fs.readDirectory(uri);
                case 'readBytes': return memory.fs.readBytes(uri);
                case 'readBytesRange': return memory.fs.readBytesRange(uri, Number(request.position), Number(request.length));
                case 'writeBytes': return memory.fs.writeBytes(uri, bytes!);
                case 'copy': return memory.fs.copy(uri, String(request.to));
                case 'move': return memory.fs.move(uri, String(request.to));
                case 'delete': return memory.fs.delete(uri);
                default: throw new Error('Unexpected fixture file operation');
            }
        },
        installer: async () => { throw new Error('No local operation may publish a remote download'); },
        deleteNow: (uri) => { calls.push('deleteNow'); memory.files.delete(uri); },
    };
    return { memory, channels, calls, holdBarrier: (hold: () => Promise<void>) => { barrier = hold; } };
};

const installGlobalChannels = (channels: NativeFileChannels) => {
    globals.__mindwtrHostPlatform = 'ios';
    globals.__mindwtrFileCall = channels.files;
    globals.__mindwtrInstallerCall = channels.installer;
    globals.__mindwtrNative = Object.fromEntries(['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']
        .map((name) => [name, () => '']));
    (globals.__mindwtrNative as Record<string, unknown>).fileDirectories = () => JSON.stringify(channels.directories);
};

afterEach(() => {
    for (const name of ['__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrFileCall', '__mindwtrInstallerCall']) delete globals[name];
    setSha256HexProvider(null);
    setLogger(consoleLogger);
});

describe('iOS independent local attachment binding', () => {
    it('returns only shared local policy without sync/maintenance ports', () => {
        const { channels } = fixture();
        expect(Object.keys(createNativeLocalAttachments(channels))).toEqual(['contractHost']);
    });

    it('allows only known unconfigured reads and refuses unknown reads, writes and secrets', async () => {
        const bindings = createNativeLocalAttachmentConfiguration();
        for (const name of [keys.SYNC_BACKEND_KEY, keys.SYNC_PATH_KEY, keys.CLOUD_PROVIDER_KEY, keys.CLOUD_URL_KEY,
            keys.WEBDAV_URL_KEY, keys.WEBDAV_USERNAME_KEY, keys.WEBDAV_ALLOW_INSECURE_HTTP_KEY]) {
            expect(await bindings.storage.getItem(name)).toBeNull();
        }
        const refused = 'Local attachment capability is not available on this host';
        for (const call of [() => bindings.storage.getItem('unknown-private-config'),
            () => bindings.storage.getItem('@mindwtr_attachment_presence_reconcile_v1'),
            () => bindings.storage.getItem('@mindwtr/file-sync-publication-reservations-v1'),
            () => bindings.storage.setItem(keys.SYNC_BACKEND_KEY, 'cloud'), () => bindings.storage.removeItem(keys.SYNC_BACKEND_KEY),
            () => bindings.getSecureConfigValue(keys.CLOUD_TOKEN_KEY), () => bindings.encryption.getSyncEncryptionMaterial(),
            () => bindings.fetch!('https://credential.invalid/private'), () => bindings.dropboxAuth!.getValidAccessToken('client'),
            () => bindings.dropboxAuth!.forceRefreshAccessToken('client'), () => bindings.getDropboxClientId!(),
            () => bindings.crypto.argon2id(new Uint8Array(), new Uint8Array(), { mKib: 1, t: 1, p: 1 }, 32),
            () => bindings.crypto.aesGcmOpen(new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array()),
            () => bindings.crypto.aesGcmSeal(new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array())]) {
            await expect(call()).rejects.toThrow(refused);
        }
        expect(() => bindings.crypto.randomBytes(1)).toThrow(refused);
        expect(() => bindings.encryption.logSyncEncryptionEvent('fixture')).toThrow(refused);
    });

    it('selects only iOS and refuses every incomplete channel set', () => {
        const { channels } = fixture();
        for (const missing of ['fileCall', 'installerCall', 'fileAbort', 'fileDirectories', 'fileDeleteNow', 'ioNext', 'ioBody']) {
            installGlobalChannels(channels);
            delete (globals.__mindwtrNative as Record<string, unknown>)[missing];
            expect(createNativeLocalAttachmentsForHost()).toBeNull();
        }
        for (const missing of ['__mindwtrFileCall', '__mindwtrInstallerCall']) {
            installGlobalChannels(channels);
            delete globals[missing];
            expect(createNativeLocalAttachmentsForHost()).toBeNull();
        }
        installGlobalChannels(channels);
        globals.__mindwtrHostPlatform = 'android';
        expect(createNativeLocalAttachmentsForHost()).toBeNull();
        globals.__mindwtrHostPlatform = 'ios';
        expect(createNativeLocalAttachmentsForHost()).not.toBeNull();
    });

    it('optional discovery refusal/malformed roots preserve the previous SHA provider', async () => {
        const { channels, calls } = fixture();
        for (const text of ['!MindwtrNativeError:PRIVATE_FIXTURE_ERROR', '{broken', 'null',
            '{}', JSON.stringify({ document: DOCUMENTS, cache: CACHE, extra: 'unbound' }),
            JSON.stringify({ document: '/outside', cache: CACHE })]) {
            installGlobalChannels(channels);
            (globals.__mindwtrNative as Record<string, unknown>).fileDirectories = () => text;
            setSha256HexProvider(() => 'a'.repeat(64));
            expect(createNativeLocalAttachmentsForHost()).toBeNull();
            expect(await computeSha256Hex(new Uint8Array())).toBe('a'.repeat(64));
        }
        installGlobalChannels(channels);
        (globals.__mindwtrNative as Record<string, unknown>).fileDirectories = () => { throw new Error('PRIVATE_FIXTURE_ERROR'); };
        expect(createNativeLocalAttachmentsForHost()).toBeNull();
        expect(calls).toEqual([]);
    });

    it('uses the native byte SHA binding only after successful construction', async () => {
        const { channels, calls } = fixture();
        installGlobalChannels(channels);
        expect(createNativeLocalAttachmentsForHost()).not.toBeNull();
        expect(await computeSha256Hex(new Uint8Array([0, 255, 17]))).toBe(createHash('sha256').update(new Uint8Array([0, 255, 17])).digest('hex'));
        expect(calls).toEqual(['sha256']);
    });

    it('copies owned cache bytes through actual core naming/safe copy and leaves task data unchanged', async () => {
        const { channels, memory } = fixture();
        const source = `${CACHE}selected.txt`;
        memory.put(source, new Uint8Array([0, 255, 17]));
        const { contractHost } = createNativeLocalAttachments(channels);
        const host = await openScreenHost({ data: { tasks: [task()] }, record: {}, log: [], bindings: { attachments: contractHost } });
        const before = JSON.stringify(useTaskStore.getState()._allTasks);
        const answer = value(await host.addAttachmentFile({ requestId: ID, owner: { kind: 'task', taskId: 'task215', attachments: [] },
            source: 'file', picked: { uri: source, name: 'fixture.txt', mimeType: 'text/plain', size: 3 } }));
        expect(answer.kind).toBe('saved');
        if (answer.kind !== 'saved') throw new Error('Expected draft result');
        expect(answer.attachments?.[0].uri).toBe(`${MANAGED}${ID}.txt`);
        expect(memory.read(`${MANAGED}${ID}.txt`)).toEqual(new Uint8Array([0, 255, 17]));
        expect(JSON.stringify(useTaskStore.getState()._allTasks)).toBe(before);
        const recreated = createNativeLocalAttachments(channels);
        expect(await recreated.contractHost.ensureAttachmentAvailableDetailed(answer.attachments![0])).toMatchObject({ status: 'available' });
    });

    it('keeps shared unavailable outcomes and metadata for absent/unreadable/external bytes', async () => {
        const { channels, memory, calls } = fixture();
        const { contractHost } = createNativeLocalAttachments(channels);
        for (const uri of [`${MANAGED}${ID}.txt`, 'file:///sibling-library/attachments/a.txt', 'file:///old-rn/private/a.txt']) {
            const input = { ...attachment(uri), cloudKey: 'retained/remote/key', fileHash: 'b'.repeat(64), contentRev: 3 };
            const before = JSON.stringify(input);
            expect(await contractHost.ensureAttachmentAvailableDetailed(input)).toEqual({ status: 'unavailable' });
            expect(JSON.stringify(input)).toBe(before);
        }
        memory.fail('getInfo', new Error('EACCES'), `${MANAGED}unreadable.txt`);
        const input = attachment(`${MANAGED}unreadable.txt`);
        expect(await contractHost.ensureAttachmentAvailableDetailed(input)).toEqual({ status: 'unavailable' });
        expect(input.uri).toBe(`${MANAGED}unreadable.txt`);
        expect(calls.every((op) => op === 'getInfo')).toBe(true);
    });

    it('preserves shared HTTP-link availability without fetching', async () => {
        const { channels, calls } = fixture();
        const { contractHost } = createNativeLocalAttachments(channels);
        expect(await contractHost.ensureAttachmentAvailableDetailed(attachment('https://example.invalid/reference')))
            .toMatchObject({ status: 'available', attachment: { localStatus: 'available' } });
        expect(calls).toEqual([]);
    });

    it('opens existing local bytes for an archived-project task without editing task data', async () => {
        const { channels, memory } = fixture();
        const input = attachment(`${MANAGED}${ID}.txt`);
        memory.put(input.uri, new Uint8Array([7]));
        const project: Project = { id: 'archived215', title: 'Archived', status: 'archived', color: '#3b82f6',
            order: 0, tagIds: [], createdAt: DATE, updatedAt: DATE };
        const { contractHost } = createNativeLocalAttachments(channels);
        const host = await openScreenHost({ data: { tasks: [{ ...task([input]), projectId: project.id }], projects: [project] },
            record: {}, log: [], bindings: { attachments: contractHost } });
        expect(value(host.getTaskView({ id: 'task215' })).readOnly).toBe(true);
        const before = JSON.stringify(useTaskStore.getState()._allTasks);
        expect(value(await host.openAttachment({ owner: { kind: 'task', taskId: 'task215', attachments: [input] }, attachmentId: input.id })))
            .toMatchObject({ status: 'available' });
        expect(JSON.stringify(useTaskStore.getState()._allTasks)).toBe(before);
        expect(memory.read(input.uri)).toEqual(new Uint8Array([7]));
    });

    it('present and missing local bytes never invoke native secrets or network bridges', async () => {
        const { channels, memory } = fixture();
        let secrets = 0;
        let network = 0;
        const previousFetch = globals.fetch;
        globals.__mindwtrSyncSecrets = { getSecret: () => { secrets += 1; throw new Error('Native secret port must stay unbound'); } };
        globals.fetch = async () => { network += 1; throw new Error('Network port must stay unbound'); };
        try {
            const { contractHost } = createNativeLocalAttachments(channels);
            const present = { ...attachment(`${MANAGED}${ID}.txt`), cloudKey: 'preserved/remote/ref' };
            memory.put(present.uri, new Uint8Array([7]));
            expect(await contractHost.ensureAttachmentAvailableDetailed(present)).toMatchObject({ status: 'available' });
            memory.files.delete(present.uri);
            expect(await contractHost.ensureAttachmentAvailableDetailed(present)).toEqual({ status: 'unavailable' });
            expect(present.cloudKey).toBe('preserved/remote/ref');
            expect(secrets).toBe(0);
            expect(network).toBe(0);
        } finally {
            globals.fetch = previousFetch;
            delete globals.__mindwtrSyncSecrets;
        }
    });

    it('an ordinary failure with the same unavailable message cannot impersonate the private sentinel', async () => {
        const { channels } = fixture();
        const { contractHost } = createNativeLocalAttachments(channels);
        const failure = new Error('Local attachment capability is not available on this host');
        const input = attachment(`${MANAGED}${ID}.txt`);
        Object.defineProperty(input, 'uri', { get: () => { throw failure; } });
        await expect(contractHost.ensureAttachmentAvailableDetailed(input)).rejects.toBe(failure);
    });

    it('keeps current ownership after the FIFO barrier and deletes only in the proof turn', async () => {
        for (const restore of [true, false]) {
            const { channels, memory, calls, holdBarrier } = fixture();
            const input = attachment(`${MANAGED}${ID}.txt`);
            memory.put(input.uri, new Uint8Array([7]));
            let release!: () => void;
            let reached!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            const waiting = new Promise<void>((resolve) => { reached = resolve; });
            holdBarrier(async () => { reached(); await held; });
            const { contractHost } = createNativeLocalAttachments(channels);
            const host = await openScreenHost({ data: { tasks: [task()] }, record: {}, log: [], bindings: { attachments: contractHost } });
            const revision = taskRevisionOf(useTaskStore.getState()._allTasks[0]);
            const outcome = host.settleTaskDraftAttachments({ taskId: 'task215', taskRevision: revision, baseline: [], draft: [input], committed: [] });
            await waiting;
            if (restore) useTaskStore.setState({ _allTasks: [task([input])], _allProjects: [] });
            release();
            expect(value(await outcome)).toEqual({ deleted: restore ? 0 : 1 });
            expect(Boolean(memory.read(input.uri))).toBe(restore);
            expect(calls.includes('deleteNow')).toBe(!restore);
            if (!restore) expect(calls.slice(-2)).toEqual(['deleteNow', 'syncParent']);
        }
    });

    it('refuses deletion of unowned/sibling paths through shared managed naming policy', async () => {
        const { channels, calls } = fixture();
        const { contractHost } = createNativeLocalAttachments(channels);
        for (const uri of [`${DOCUMENTS}sibling/a.txt`, 'file:///sibling/attachments/a.txt', `${MANAGED}nested/a.txt`]) {
            expect(await contractHost.deleteManagedAttachmentFile(attachment(uri))).toBe(false);
        }
        expect(calls.every((op) => op === 'makeDirectory')).toBe(true);
    });
});
