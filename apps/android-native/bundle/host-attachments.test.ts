import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeCloudKitAssets, type NativeCloudKitTransportRequest } from '../../ios-native/bundle/host-cloudkit-assets';
import { defaultSyncCryptoPrimitives } from '../../../packages/core/src/sync-crypto';
import { getAttachmentDownloadIdentity } from '../../../packages/core/src/mobile-attachment-availability';
import {
    createNativeAttachments, createNativeLocalAttachmentConfiguration, createNativeTaskAttachmentPreparation,
    prepareNativeTaskAttachmentAvailabilityPreflight, prepareNativeTaskAttachmentAvailability, nativeTaskAttachmentPreparationUsesCloudKit,
    type NativeTaskAttachmentPreparationBindings,
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


const CLOUD_REQUEST = '00000000-0000-4000-8000-000000000a10';
const CLOUD_SESSION = '00000000-0000-4000-8000-000000000a11';
const CLOUD_SOURCE = '00000000-0000-4000-8000-000000000a12';
const selectedCloudAttachment = (): Attachment => ({ id: 'cloudkit-selected', kind: 'file', title: 'Selected.txt', uri: '',
    cloudKey: 'cloudkit:legacy/é😀', localStatus: 'missing', createdAt: DATE, updatedAt: DATE });
const selectedCloudInput = (selected = selectedCloudAttachment()) => ({ version: 1, taskID: 'selected-task',
    beforePayloadJSON: JSON.stringify({ version: 2, taskID: 'selected-task', attachmentsOwned: true,
        attachmentsBase: [selected], attachments: [selected], opaque: { notes: 'Keep draft' } }),
    requestJSON: JSON.stringify({ version: 1, requestId: CLOUD_REQUEST, sessionID: CLOUD_SESSION, generation: 3,
        attachmentId: selected.id, identity: getAttachmentDownloadIdentity(selected) }),
});
const selectedCloudRaw = () => JSON.stringify({ ...selectedCloudInput(), rawConfigJSON: '{"backend":"cloudkit"}' });
const selectedCloudFixture = () => {
    const memory = createMemoryFileSystem(), fileCalls: string[] = [], requests: NativeCloudKitTransportRequest[] = [];
    const sources: { metadata: unknown; base64: string }[] = [], signals: (AbortSignal | undefined)[] = [];
    let payload = new Uint8Array([0, 255, 1]);
    setSha256HexProvider((bytes) => createHash('sha256').update(bytes).digest('hex'));
    const cloudKit = createNativeCloudKitAssets(async (request, signal) => {
        requests.push(request); signals.push(signal);
        if (request.op !== 'fetchAttachmentAsset') throw new Error('Selected CloudKit may only fetch');
        memory.put(request.targetPath, payload);
        return JSON.stringify({ recordName: request.recordName, attachmentId: 'cloudkit-selected', ownerType: 'task',
            ownerId: 'selected-task', title: 'Remote title must not overwrite draft', updatedAt: DATE });
    });
    const forbidden = async (): Promise<never> => { throw new Error('No HTTP, credentials, encryption or raw mutation'); };
    const channels: NativeFileChannels = { directories: { document: DOCUMENTS, cache: CACHE },
        files: async (request, bytes) => {
            const op = String(request.op); fileCalls.push(op);
            if (op === 'getInfo') return memory.fs.getInfo(String(request.uri));
            if (op === 'readBytes') return memory.fs.readBytes(String(request.uri));
            if (op === 'sha256' && bytes) return createHash('sha256').update(bytes).digest('hex');
            return forbidden();
        }, installer: forbidden, deleteNow: () => { throw new Error('No JS selected scratch cleanup'); } };
    const bindings: NativeTaskAttachmentPreparationBindings = { rawConfigJSON: '{"backend":"cloudkit"}', cloudKit,
        getLegacyValue: forbidden, getSecret: forbidden, fetch: forbidden, crypto: defaultSyncCryptoPrimitives,
        prepareSource: (raw, base64) => { sources.push({ metadata: JSON.parse(raw), base64 });
            return JSON.stringify({ kind: 'prepared-source', sourceToken: CLOUD_SOURCE }); } };
    return { memory, fileCalls, requests, sources, signals, channels, bindings,
        payload: (bytes: Uint8Array) => { payload = bytes; },
        run: (signal = new AbortController().signal) => prepareNativeTaskAttachmentAvailability(selectedCloudRaw(), bindings, channels, signal) };
};

describe('selected CloudKit preparation JS binding', () => {
    it('returns the closed native preflight with canonical CloudKit target naming and exact selected metadata', async () => {
        const selected = selectedCloudAttachment();
        const input = { ...selectedCloudInput(selected), cloudKit: true, managedDirectoryURI: MANAGED };
        expect(await prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify(input))).toEqual({ version: 1,
            requestId: CLOUD_REQUEST, attachmentJSON: JSON.stringify(selected), recordName: 'legacy/é😀',
            targetURI: MANAGED + selected.id + '.txt' });
        for (const bad of [{ ...input, cloudKit: false }, { ...input, cloudKit: 'true' }, { ...input, webdavURL: 'https://invalid.test' },
            { ...input, cloudURL: 'https://invalid.test' }, { ...input, encryptionStateJSON: null }, { ...input, managedDirectoryURI: 'file:///no-trailing' }]) {
            await expect(prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify(bad))).rejects.toThrow('INVALID_INPUT');
        }
        const httpKey = selectedCloudAttachment(); httpKey.cloudKey = 'attachments/file.txt';
        await expect(prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify({ ...selectedCloudInput(httpKey), cloudKit: true,
            managedDirectoryURI: MANAGED }))).rejects.toThrow('INVALID_INPUT');
    });

    it('requires exact CloudKit config and explicit binding before any IO; retains old HTTP config routing', async () => {
        const f = selectedCloudFixture();
        expect(nativeTaskAttachmentPreparationUsesCloudKit(selectedCloudRaw())).toBe(true);
        for (const raw of ['{"backend":"cloudkit","url":null}', '{"backend":"cloudkit","encryptionStateJSON":null}',
            '{"backend":"cloudkit","provider":null}']) {
            expect(() => createNativeTaskAttachmentPreparation({ ...f.bindings, rawConfigJSON: raw }, f.channels)).toThrow('INVALID_INPUT');
            expect(() => nativeTaskAttachmentPreparationUsesCloudKit(JSON.stringify({ ...selectedCloudInput(), rawConfigJSON: raw }))).toThrow('INVALID_INPUT');
        }
        expect(() => createNativeTaskAttachmentPreparation({ ...f.bindings, cloudKit: undefined }, f.channels)).toThrow('INVALID_INPUT');
        const rawConfigJSON = JSON.stringify({ backend: 'webdav', url: 'https://synthetic.invalid/dav', username: null,
            allowInsecureHttp: null, encryptionStateJSON: null });
        expect(nativeTaskAttachmentPreparationUsesCloudKit(JSON.stringify({ ...selectedCloudInput(), rawConfigJSON }))).toBe(false);
        expect(f.fileCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
    });

    it('prepares only SDK scratch bytes with one existing source callback and no credential, HTTP or installer access', async () => {
        const f = selectedCloudFixture(), controller = new AbortController(), selected = selectedCloudAttachment();
        const before = structuredClone(selected);
        const result = await f.run(controller.signal);
        expect(result.status).toBe('prepared');
        if (result.status !== 'prepared') throw new Error('Prepared result required');
        expect(result.sourceToken).toBe(CLOUD_SOURCE); expect(result.requestId).toBe(CLOUD_REQUEST);
        expect(JSON.parse(result.attachmentJSON)).toMatchObject({ id: selected.id, title: selected.title,
            cloudKey: selected.cloudKey, uri: MANAGED + selected.id + '.txt' });
        expect(f.sources).toHaveLength(1); expect(f.sources[0].base64).toBe('AP8B');
        expect(f.sources[0].metadata).toMatchObject({ version: 1, attachmentId: selected.id, targetURI: MANAGED + selected.id + '.txt' });
        expect(f.requests).toHaveLength(1); expect(f.requests[0]).toMatchObject({ op: 'fetchAttachmentAsset', recordName: 'legacy/é😀' });
        expect(f.signals).toEqual([controller.signal]);
        expect(f.fileCalls.every((op) => op === 'getInfo' || op === 'readBytes' || op === 'sha256')).toBe(true);
        expect(f.memory.read(MANAGED + selected.id + '.txt')).toBeUndefined();
        expect(selected).toEqual(before);
    });

    it('does not create a source from oversized selected bytes or a cancelled invocation', async () => {
        const f = selectedCloudFixture(); f.payload(new Uint8Array(8 * 1024 * 1024 + 1));
        expect((await f.run()).status).toBe('unavailable'); expect(f.sources).toEqual([]);
        const fresh = selectedCloudFixture(), controller = new AbortController(); controller.abort(new Error('retired'));
        await expect(fresh.run(controller.signal)).rejects.toThrow('retired');
        expect(fresh.requests).toEqual([]); expect(fresh.fileCalls).toEqual([]); expect(fresh.sources).toEqual([]);
    });
});

const selectedCloudEntryFixture = (prepare: (bindings: Omit<NativeTaskAttachmentPreparationBindings, 'rawConfigJSON'>, signal: AbortSignal) => Promise<unknown>, platform = 'ios', capable = true) => {
    const entry = readFileSync(import.meta.dir + '/host-entry.ts', 'utf8');
    const queue = entry.slice(entry.indexOf('const iosCloudKitAvailable ='), entry.indexOf('const iosCloudKitRecords ='));
    const handler = entry.slice(entry.indexOf('    iosTaskDraftPrepareAvailability('), entry.indexOf('    iosProjectFilePrepareAvailability('));
    const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(queue + `
globalThis.port = {${handler}};`);
    const calls: NativeCloudKitTransportRequest[] = [];
    const context = vm.createContext({ __mindwtrHostPlatform: platform,
        native: () => ({ cloudKitAvailable: () => capable }), iosCleanupCallback: null,
        bootAdapter: {}, localAttachments: {}, nativeSync: null, iosTaskAttachmentPreparation: false,
        iosProjectFilePreparation: false, iosForegroundFailure: false,
        submit: (work: (signal: AbortSignal) => unknown) => work(new AbortController().signal),
        isSandboxMode: () => false, isWorkspaceTransitionActive: () => false, requireSaved: () => {},
        nativeFileChannels: () => ({}), nativeTaskAttachmentPreparationUsesCloudKit, createNativeCloudKitAssets,
        createHostSyncCrypto: () => defaultSyncCryptoPrimitives,
        keyValue: { get: () => { throw new Error('No selected legacy credentials'); } },
        prepareNativeTaskAttachmentAvailability: (_json: string, bindings: Omit<NativeTaskAttachmentPreparationBindings, 'rawConfigJSON'>,
            _channels: unknown, signal: AbortSignal) => prepare(bindings, signal),
        __mindwtrCloudKitCall: async (input: NativeCloudKitTransportRequest) => { calls.push(input);
            if (input.op !== 'fetchAttachmentAsset') throw new Error('No selected record writes');
            return JSON.stringify({ recordName: input.recordName, attachmentId: 'asset', ownerType: 'task', ownerId: 'task', title: 'Asset', updatedAt: DATE }); },
    });
    vm.runInContext(source, context);
    const port: { iosTaskDraftPrepareAvailability(raw: string, callback: (metadata: string, bytes: string) => string): Promise<unknown> } = vm.runInContext('port', context);
    return { port, calls, context };
};

describe('actual selected CloudKit host-entry owner', () => {
    it('admits only capable iOS, does not require/read HTTP secrets, and clears the exact source owner after settlement', async () => {
        let binding: Omit<NativeTaskAttachmentPreparationBindings, 'rawConfigJSON'> | undefined;
        const prepare = async (value: Omit<NativeTaskAttachmentPreparationBindings, 'rawConfigJSON'>) => {
            binding = value;
            if (!value.cloudKit) throw new Error('Expected selected port');
            await expect(value.cloudKit.deleteAttachmentAssets(['forbidden-record'])).rejects.toThrow('CloudKit requires an owned foreground invocation');
            return value.cloudKit.fetchAttachmentAsset('selected-record', 'file:///owned/stage');
        };
        for (const [platform, capable] of [['android', true], ['ios', false]] as const) {
            const refused = selectedCloudEntryFixture(prepare, platform, capable);
            await expect(refused.port.iosTaskDraftPrepareAvailability(selectedCloudRaw(), () => '{}')).rejects.toThrow('NOT_READY');
            expect(refused.calls).toEqual([]);
        }
        const f = selectedCloudEntryFixture(prepare);
        await f.port.iosTaskDraftPrepareAvailability(selectedCloudRaw(), () => '{}');
        expect(f.calls).toEqual([{ op: 'fetchAttachmentAsset', recordName: 'selected-record', targetPath: 'file:///owned/stage' }]);
        expect(vm.runInContext('iosSelectedCloudKitSource', f.context)).toBeNull();
        if (!binding?.cloudKit) throw new Error('Expected selected binding');
        await expect(binding.cloudKit.fetchAttachmentAsset('late', 'file:///owned/stage')).rejects.toThrow('NOT_READY');
        expect(() => binding?.prepareSource('{}', '')).toThrow('NOT_READY');
        expect(f.calls).toHaveLength(1);
    });

    it('queued old work and a retained old port cannot borrow a later source owner', async () => {
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        let turn = 0, old: Omit<NativeTaskAttachmentPreparationBindings, 'rawConfigJSON'> | undefined;
        let oldPending: Promise<unknown> = Promise.resolve();
        const f = selectedCloudEntryFixture(async (binding) => {
            if (++turn === 1) {
                old = binding;
                oldPending = binding.cloudKit!.fetchAttachmentAsset('old-queued', 'file:///owned/old').catch((error: unknown) => error);
                return { status: 'unavailable' };
            }
            if (!old?.cloudKit) throw new Error('Expected previous port');
            await expect(old.cloudKit.fetchAttachmentAsset('old-late', 'file:///owned/old')).rejects.toThrow('NOT_READY');
            return binding.cloudKit!.fetchAttachmentAsset('new-selected', 'file:///owned/new');
        });
        f.context.hold = hold; vm.runInContext('iosCloudKitTail = hold', f.context);
        const callback1 = () => '{}', callback2 = () => '{}';
        await f.port.iosTaskDraftPrepareAvailability(selectedCloudRaw(), callback1);
        const current = f.port.iosTaskDraftPrepareAvailability(selectedCloudRaw(), callback2);
        await Promise.resolve(); release(); await current;
        expect(await oldPending).toHaveProperty('message', 'CloudKit requires an owned foreground invocation');
        expect(f.calls).toEqual([{ op: 'fetchAttachmentAsset', recordName: 'new-selected', targetPath: 'file:///owned/new' }]);
        expect(vm.runInContext('iosSelectedCloudKitSource', f.context)).toBeNull();
    });
});

describe('native File Sync attachment pass', () => {
    it('writes a new attachment generation into the picked SAF folder through the host SAF port', async () => {
        const TREE = 'content://com.android.externalstorage.documents/tree/primary%3AMindwtr';
        const FOLDER = `${TREE}/document/primary%3AMindwtr`;
        const memory = createMemoryFileSystem();
        const bytes = new TextEncoder().encode('fixture');
        const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
        const children = new Map<string, { uri: string; name: string }[]>([[FOLDER, []]]);
        const saf: NonNullable<NativeAttachmentBindings['saf']> = {
            listChildren: async (uri) => (children.get(uri) ?? []).map((entry) => ({ ...entry, size: null })),
            stat: async (uri) => [...children.values()].flat().find((entry) => entry.uri === uri)
                ? { uri, name: [...children.values()].flat().find((entry) => entry.uri === uri)!.name, size: null } : null,
            readBytes: async () => { throw new Error('Unexpected sync-file read'); },
            writeBytes: async (uri, value) => { memory.put(uri, value); },
            writeText: async () => { throw new Error('Unexpected text write'); },
            createFile: async (parent, name) => {
                const uri = `${parent}%2F${name}`;
                children.get(parent)!.push({ uri, name });
                return uri;
            },
            makeDirectory: async (parent, name) => {
                const uri = `${parent}%2F${name}`;
                children.get(parent)!.push({ uri, name });
                children.set(uri, []);
                return uri;
            },
            delete: async () => { throw new Error('Unexpected delete'); },
            rename: async () => { throw new Error('Unexpected rename'); },
        };
        const channels: NativeFileChannels = {
            directories: { document: DOCUMENTS, cache: CACHE },
            files: async (request, body) => {
                const uri = String(request.uri ?? '');
                switch (String(request.op)) {
                    case 'getInfo': return memory.fs.getInfo(uri);
                    case 'makeDirectory': return memory.fs.makeDirectory(uri);
                    case 'copy': return memory.fs.copy(uri, String(request.to));
                    case 'delete': return memory.fs.delete(uri);
                    case 'readBytes': return memory.fs.readBytes(uri);
                    case 'sha256': return digest(body!);
                    case 'sha256File': return digest(memory.read(uri)!);
                    default: throw new Error(`Unexpected fixture file operation ${String(request.op)}`);
                }
            },
            installer: async () => { throw new Error('Unexpected installer operation'); },
            deleteNow: () => { throw new Error('Unexpected raw delete'); },
        };
        const local = createNativeLocalAttachmentConfiguration();
        const warnings: string[] = [];
        const native = createNativeAttachments({ ...local, saf,
            encryption: { getSyncEncryptionMaterial: async () => null, logSyncEncryptionEvent: () => {} },
            log: { info: () => {}, warn: (message, context) => { warnings.push(`${message} ${JSON.stringify(context ?? {})}`); }, sanitize: (message) => message },
            storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }, channels);
        const uri = `${MANAGED}fixture.pdf`;
        memory.put(uri, bytes);
        const data: AppData = { tasks: [{ id: 'task-1', title: 'Fixture', status: 'inbox', tags: [], contexts: [],
            createdAt: DATE, updatedAt: DATE, attachments: [{ ...attachment(uri), localStatus: 'available' }] }],
        projects: [], sections: [], areas: [], settings: {} };

        const result = await native.syncPort.syncFile(data, FOLDER, new AbortController().signal, { activationProbe: false });

        expect(warnings).toEqual([]);
        const cloudKey = (result as AppData).tasks[0].attachments![0].cloudKey!;
        expect(cloudKey).toStartWith('attachments/');
        const written = children.get(`${FOLDER}%2Fattachments`)!;
        expect(written.map((entry) => entry.name)).toEqual([cloudKey.split('/').pop()!]);
        expect(memory.read(written[0].uri)).toEqual(bytes);
    });
});
