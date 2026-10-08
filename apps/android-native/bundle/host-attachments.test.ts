import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    createNativeAttachments, createNativeLocalAttachmentConfiguration,
    type NativeAttachmentBindings, type NativeFileChannels,
} from './host-attachments';
import { setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
import { NativeAttachmentCleanupUnconfirmedError } from '../../../packages/core/src/native-attachment-cleanup';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import type { MobileSyncAttachmentCleanupOptions } from '../../../packages/core/src/mobile-sync-service';
import type { AppData, Attachment } from '../../../packages/core/src/types';

const DATE = '2026-10-06T00:00:00.000Z';
const TASK_ID = '00000000-0000-4000-8000-000000000A14';
const PROJECT_ID = '00000000-0000-4000-8000-000000000B14';
const attachment = (uri: string, id = TASK_ID): Attachment => ({
    id, kind: 'file', title: 'fixture.pdf', uri, createdAt: DATE, updatedAt: DATE,
});
const dataWith = (uri: string): AppData => ({
    tasks: [{ id: 'purged-task', title: 'Fixture', status: 'done', tags: [], contexts: [],
        createdAt: DATE, updatedAt: DATE, deletedAt: DATE, purgedAt: DATE, attachments: [attachment(uri)] }],
    projects: [], sections: [], areas: [], settings: {},
});

const fixture = (retireLocalAttachment?: NativeAttachmentBindings['retireLocalAttachment']) => {
    const memory = createMemoryFileSystem();
    const calls: string[] = [];
    const channels: NativeFileChannels = {
        directories: { document: DOCUMENTS, cache: CACHE },
        files: async (request) => {
            const op = String(request.op);
            const uri = String(request.uri ?? '');
            calls.push(op);
            switch (op) {
                case 'barrier': case 'syncParent': return null;
                case 'getInfo': return memory.fs.getInfo(uri);
                case 'makeDirectory': return memory.fs.makeDirectory(uri);
                case 'delete': return memory.fs.delete(uri);
                default: throw new Error('Unexpected fixture file operation');
            }
        },
        installer: async () => { throw new Error('Unexpected installer operation'); },
        deleteNow: (uri) => { calls.push('deleteNow'); memory.files.delete(uri); },
    };
    const bindings = { ...createNativeLocalAttachmentConfiguration(), ...(retireLocalAttachment ? { retireLocalAttachment } : {}) };
    const native = createNativeAttachments(bindings, channels);
    const options = (appData: AppData): MobileSyncAttachmentCleanupOptions => ({
        appData, backend: 'off', webdavConfig: null, cloudConfig: null, cloudProvider: 'selfhosted',
        fetcher: mock(async () => { throw new Error('Unexpected remote request'); }) as unknown as typeof fetch,
        ensureLocalSnapshotFresh: mock(() => undefined), assertRemoteMutationFenceHeld: mock(async () => undefined),
        deleteDropboxAttachment: mock(async () => undefined), isRemoteMissingError: () => false,
        logSyncInfo: mock(() => undefined), logSyncWarning: mock(() => undefined),
    });
    return { native, memory, calls, options };
};

afterEach(() => setSha256HexProvider(null));

describe('native selected attachment cleanup binding', () => {
    it('forwards the exact Task and Project selections through the real syncPort without raw file fallback', async () => {
        const uri = `${MANAGED}not-an-id%20name.pdf`;
        const ensureFresh = mock(() => undefined);
        const retire = mock(async (_id: string, _uri: string, keep: () => boolean) => {
            const before = ensureFresh.mock.calls.length;
            await Promise.resolve();
            expect(keep()).toBe(false);
            expect(ensureFresh.mock.calls.length).toBe(before + 1);
            return false;
        });
        const { native, memory, calls, options: makeOptions } = fixture(retire);
        const data = dataWith(` ${uri} `);
        data.projects = [{ id: 'purged-project', title: 'Fixture', status: 'archived', order: 0, tags: [],
            createdAt: DATE, updatedAt: DATE, deletedAt: DATE, purgedAt: DATE, attachments: [attachment(` ${uri} `, PROJECT_ID)] }];
        const before = structuredClone(data);
        const options = makeOptions(data);
        options.ensureLocalSnapshotFresh = ensureFresh;
        memory.put(uri, new Uint8Array([0, 255]));

        const result = await native.syncPort.runCleanup(options);

        expect(retire.mock.calls.map(([id, target]) => [id, target])).toEqual([[TASK_ID, uri], [PROJECT_ID, uri]]);
        expect(calls).toEqual([]);
        expect(memory.read(uri)).toEqual(new Uint8Array([0, 255]));
        expect(result.appData.tasks[0].attachments).toEqual([]);
        expect(result.appData.projects[0].attachments).toEqual([]);
        expect(data).toEqual(before);
        expect(options.logSyncInfo).toHaveBeenCalledTimes(2);
        expect(options.logSyncInfo).toHaveBeenCalledWith('Attachment cleanup freshness guarded', {
            releaseCheck: 'v1.3.5/native-cleanup-freshness', outcome: 'retained',
        });
    });

    it('preserves fatal identity through the real factory and stops metadata, remote and log callbacks', async () => {
        const uri = `${MANAGED}fixture.pdf`;
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        const retire = mock(async () => { throw fatal; });
        const { native, memory, calls, options: makeOptions } = fixture(retire);
        const data = dataWith(uri);
        data.tasks[0].attachments![0].cloudKey = 'attachments/fixture.pdf';
        const before = structuredClone(data);
        const options = makeOptions(data);
        options.backend = 'webdav';
        options.webdavConfig = { url: 'https://fixture.invalid/data.json', username: '', password: '' };
        memory.put(uri, new Uint8Array([1]));

        const refusal = await native.syncPort.runCleanup(options).catch((error: unknown) => error);

        expect(refusal).toBe(fatal);
        expect(retire).toHaveBeenCalledWith(TASK_ID, uri, expect.any(Function));
        expect(calls).toEqual([]);
        expect(memory.read(uri)).toEqual(new Uint8Array([1]));
        expect(data).toEqual(before);
        for (const callback of [options.fetcher, options.deleteDropboxAttachment,
            options.assertRemoteMutationFenceHeld, options.logSyncInfo, options.logSyncWarning]) {
            expect(callback).not.toHaveBeenCalled();
        }
    });

    it('retains the no-option Android barrier, synchronous delete and parent sync cleanup', async () => {
        const uri = `${MANAGED}fixture.pdf`;
        const { native, memory, calls, options: makeOptions } = fixture();
        memory.put(uri, new Uint8Array([1]));
        const options = makeOptions(dataWith(uri));

        const result = await native.syncPort.runCleanup(options);

        expect(calls).toEqual(['barrier', 'deleteNow', 'syncParent']);
        expect(memory.read(uri)).toBeUndefined();
        expect(result.appData.tasks[0].attachments).toEqual([]);
        expect(options.logSyncInfo).toHaveBeenCalledWith('Attachment cleanup freshness guarded', {
            releaseCheck: 'v1.3.5/native-cleanup-freshness', outcome: 'removed',
        });
    });

    it('does not redirect editor contractHost deletion to the selected cleanup callback', async () => {
        const retire = mock(async () => { throw new Error('Editor deletion must not use cleanup ownership'); });
        const { native, memory, calls } = fixture(retire);
        const uri = `${MANAGED}${TASK_ID}.pdf`;
        memory.put(uri, new Uint8Array([1]));

        expect(await native.contractHost.deleteManagedAttachmentFile(attachment(uri))).toBe(true);

        expect(retire).not.toHaveBeenCalled();
        expect(memory.read(uri)).toBeUndefined();
        expect(calls).toContain('barrier');
        expect(calls.slice(-2)).toEqual(['deleteNow', 'syncParent']);
    });
});


describe('selected existing native attachment preparation adapter', () => {
    it('verifies the current bytes without any attempted directory creation, install or remote read', async () => {
        const memory = createMemoryFileSystem(), calls: string[] = [];
        const uri = MANAGED + '852d70cf-303a-47d0-98cb-d16de850a94d.txt';
        const bytes = new Uint8Array([0, 255, 17, 32]);
        memory.put(uri, bytes);
        const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
        const channels: NativeFileChannels = {
            directories: { document: DOCUMENTS, cache: CACHE },
            files: async (request, body) => {
                const op = String(request.op); calls.push(op);
                if (op === 'getInfo') return memory.fs.getInfo(String(request.uri));
                if (op === 'readBytes') return memory.fs.readBytes(String(request.uri));
                if (op === 'sha256' && body) return digest(body);
                throw new Error('Selected adapter attempted a file mutation');
            },
            installer: async () => { calls.push('installer'); throw new Error('Selected installer refused'); },
            deleteNow: () => { calls.push('deleteNow'); throw new Error('Selected delete refused'); },
        };
        const local = createNativeLocalAttachmentConfiguration();
        const network = mock(async () => { throw new Error('Selected network refused'); });
        const native = createNativeAttachments({ ...local, fetch: network as unknown as typeof fetch,
            storage: { ...local.storage, getItem: async (key) => key === '@mindwtr_sync_backend' ? 'webdav' : null } }, channels);
        const selected = { ...attachment(uri), id: '852d70cf-303a-47d0-98cb-d16de850a94d',
            cloudKey: 'attachments/852d70cf-303a-47d0-98cb-d16de850a94d.txt', fileHash: digest(bytes),
            pendingContentUpload: false, localStatus: 'missing' as const, size: 4 };
        expect(await native.prepareAttachmentAvailableDetailed!(selected)).toEqual({ status: 'available',
            attachment: { ...selected, localStatus: 'available' } });
        expect(calls).toEqual(['getInfo', 'readBytes', 'sha256']);
        expect(network).not.toHaveBeenCalled(); expect(memory.read(uri)).toEqual(bytes);
        calls.length = 0;
        expect(await native.prepareAttachmentAvailableDetailed!({ ...selected, fileHash: 'a'.repeat(64) }))
            .toEqual({ status: 'generation-conflict' });
        expect(calls).toEqual(['getInfo', 'readBytes', 'sha256']);
        expect(network).not.toHaveBeenCalled(); expect(memory.read(uri)).toEqual(bytes);
        calls.length = 0;
        expect(await native.prepareAttachmentAvailableDetailed!({ ...selected, cloudKey: undefined }))
            .toEqual({ status: 'available', attachment: { ...selected, cloudKey: undefined, localStatus: 'available' } });
        expect(calls).toEqual(['getInfo', 'readBytes', 'sha256']);
        expect(network).not.toHaveBeenCalled(); expect(memory.read(uri)).toEqual(bytes);
        calls.length = 0;
        memory.files.delete(uri);
        expect(await native.prepareAttachmentAvailableDetailed!({ ...selected, cloudKey: undefined }))
            .toEqual({ status: 'unavailable' });
        expect(calls).toEqual(['getInfo']); expect(network).not.toHaveBeenCalled(); expect(memory.read(uri)).toBeUndefined();
    });
});
