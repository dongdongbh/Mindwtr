import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import type { AppData, Attachment, Task } from './types';
import type { SyncBackendIO, SyncRunAttachmentHelpers, SyncRunResult } from './sync-run-ports';
import { clearIdleSyncCycleSnapshot, runSharedSyncCycle } from './sync-run';
import { cloneAppData } from './sync-runtime-utils';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { computeSha256Hex } from './attachment-hash';
import { buildFileSyncGenerationCloudKey } from './attachment-paths';
import { createAttachmentTransferAdmission } from './attachment-transfer';
import { createMobileAttachmentFiles } from './mobile-attachment-files';
import { createMobileAttachmentCommon } from './mobile-attachment-common';
import { createMobileAttachmentBackends, type MobileAttachmentBackendsCoreFunctions } from './mobile-attachment-backends';
import { WebDavRemoteWriteConflictError } from './webdav';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';


const require = createRequire(import.meta.url);
type Database = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;

beforeEach(() => { clearIdleSyncCycleSnapshot(); });

type BackendName = 'webdav' | 'cloud' | 'dropbox' | 'file';
type Etag = 'strong' | 'weak' | 'missing';
type Cell = { backend: BackendName; hashed: boolean; etag: Etag };
const CELLS: Cell[] = [
    ...(['strong', 'weak', 'missing'] as const).flatMap((etag) => [true, false].map((hashed) => ({ backend: 'webdav' as const, hashed, etag }))),
    ...(['cloud', 'dropbox', 'file'] as const).flatMap((backend) => [true, false].map((hashed) => ({ backend, hashed, etag: 'strong' as const }))),
];
const cellName = (cell: Cell) => `${cell.backend}${cell.backend === 'webdav' ? ` ${cell.etag} ETag` : ''} ${cell.hashed ? 'with fileHash' : 'hashless'}`;
const table = (cells: Cell[]) => cells.map((cell) => [cellName(cell), cell] as const);

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = async (data: Uint8Array) => (await computeSha256Hex(data))!;
const UP = bytes('A: the bytes this device uploads');

const OTHER = bytes('B: bytes another writer put here');
const DOWN = bytes('the bytes another device uploaded');
const WRONG = bytes('an unrelated local file');
const STAMP = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const DAV = 'https://dav.example.test/Mindwtr';
const CLOUD = 'https://cloud.example.test/v1';
const SYNC_PATH = 'file:///sdcard/Mindwtr/data.json';
const FOLDER = 'file:///sdcard/Mindwtr/attachments/';
const UP_URI = `${MANAGED}up.txt`;
const DOWN_TARGET = `${MANAGED}down.txt`;

const task = (id: string, attachment: Attachment): Task => ({
    id, title: id, status: 'inbox', tags: [], contexts: [], attachments: [attachment], createdAt: STAMP, updatedAt: STAMP,
} as Task);
const doc = (tasks: Task[]): AppData => ({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} });
const attachmentsOf = (data: AppData) => new Map(data.tasks.flatMap((t) => t.attachments ?? []).map((a) => [a.id, a]));
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const idOfKey = (key: string) => key.split('/').pop()!.split(/[.-]/)[0];

type Transfer = { cycle: number; id: string; dir: 'put' | 'get' };


const createWorld = async (cell: Cell) => {
    const db = new DatabaseSync(':memory:');

    const alive = () => { if (world.dead) throw new Error('the process is dead'); };
    const client: SqliteClient = {
        run: async (sql, params = []) => { alive(); db.prepare(sql).run(...params); },
        all: async <T,>(sql: string, params: unknown[] = []) => { alive(); return db.prepare(sql).all(...params) as T[]; },
        get: async <T,>(sql: string, params: unknown[] = []) => { alive(); return db.prepare(sql).all(...params)[0] as T | undefined; },
        exec: async (sql) => { alive(); db.exec(sql); },
    };
    const memory = createMemoryFileSystem({ sha256: sha });
    const { storage } = createMemoryStorage();
    const blobs = new Map<string, { data: Uint8Array; version: number }>();
    const world = {
        cell, client, memory, storage, blobs,
        cycle: 0,
        dead: false,
        transfers: [] as Transfer[],
        remoteDoc: null as AppData | null,

        upBlobAtDocWrite: [] as (Uint8Array | undefined)[],

        onTransfer: undefined as undefined | ((transfer: Transfer) => void),
        upKey: '',
        downKey: '',
    };
    const record = (key: string, dir: Transfer['dir']) => {
        const transfer = { cycle: world.cycle, id: idOfKey(key), dir };
        world.transfers.push(transfer);
        return transfer;
    };
    const keyOf = (url: string) => url.slice(url.indexOf('/attachments/') + 1);
    const store = (key: string, data: ArrayBuffer | Uint8Array) => {
        blobs.set(key, { data: new Uint8Array(data as ArrayBuffer).slice(), version: (blobs.get(key)?.version ?? 0) + 1 });
    };
    const put = (key: string, data: ArrayBuffer | Uint8Array) => {
        const transfer = record(key, 'put');
        store(key, data);
        world.onTransfer?.(transfer);
    };
    const get = (key: string): ArrayBuffer => {
        const transfer = record(key, 'get');
        world.onTransfer?.(transfer);
        const blob = blobs.get(key);
        if (!blob) throw httpError(404);
        return blob.data.slice().buffer as ArrayBuffer;
    };
    const etagOf = (version: number) => (cell.etag === 'strong' ? `"v${version}"` : cell.etag === 'weak' ? `W/"v${version}"` : null);
    const core: Partial<MobileAttachmentBackendsCoreFunctions> = {
        withRetry: (operation) => operation(),
        webdavMakeDirectory: async () => undefined,
        webdavFileExists: async (url) => blobs.has(keyOf(url)),
        webdavHeadFile: async (url) => {
            const blob = blobs.get(keyOf(url));
            return { exists: Boolean(blob), etag: blob ? etagOf(blob.version) : null, fingerprint: null, lastModified: null, contentLength: blob ? String(blob.data.byteLength) : null };
        },

        webdavPutFileVersioned: async (url, data, _type, expectedEtag) => {
            const blob = blobs.get(keyOf(url));
            if (blob ? expectedEtag !== `"v${blob.version}"` : expectedEtag !== null) throw new WebDavRemoteWriteConflictError(412);
            put(keyOf(url), data as ArrayBuffer);
        },
        webdavGetFile: async (url) => get(keyOf(url)),
        cloudAttachmentExists: async (url) => blobs.has(keyOf(url)),
        cloudGetFile: async (url) => get(keyOf(url)),
        cloudPutFile: async (url, data) => { put(keyOf(url), data as ArrayBuffer); },
        listDropboxFolderFiles: async () => [...blobs.keys()].map((key) => ({ name: key.split('/').pop()! })) as never,
        getDropboxFileMetadata: async (_token, path) => ({ rev: blobs.has(path) ? `rev-${blobs.get(path)!.version}` : null }),
        uploadDropboxFileVersioned: async (_token, path, data, rev) => {
            const current = blobs.get(path);
            if ((current ? `rev-${current.version}` : null) !== rev) throw Object.assign(new Error('conflict'), { status: 409 });
            put(path, data);
            return { rev: `rev-${blobs.get(path)!.version}` };
        },
        downloadDropboxFile: async (_token, path) => get(path),
    };


    const installer = {
        hashAttachmentFileGeneration: vi.fn(async (path: string) => {
            const data = memory.read(path);
            if (!data) throw new Error(`ENOENT ${path}`);
            return { sha256: await sha(data), size: data.byteLength, modificationTimeMs: 1 };
        }),
        installAttachmentFileGeneration: vi.fn(async (staged: string, target: string, expectation: { kind: string; sha256?: string }) => {
            const current = memory.read(target);
            const incoming = await sha(memory.read(staged)!);
            const allowed = expectation.kind === 'absent'
                ? !current || await sha(current) === incoming
                : Boolean(current) && await sha(current!) === expectation.sha256;
            if (!allowed) return { status: 'conflict' as const, preservedPath: staged };
            await memory.fs.move(staged, target);
            return { status: 'installed' as const };
        }),
        recoverFileSyncAttachmentPublications: vi.fn(async () => undefined),
        reserveFileSyncAttachmentPublication: vi.fn(async (targetPath: string) => ({ operationId: 'op', stagedPath: `${targetPath}.stage`, targetPath })),
        claimFileSyncAttachmentPublication: vi.fn(async () => undefined),
        publishImmutableAttachmentFileGeneration: vi.fn(async (staged: string, target: string) => {
            if (memory.read(target)) return { status: 'alreadyExists' as const };
            const transfer = record(target, 'put');
            await memory.fs.move(staged, target);
            world.onTransfer?.(transfer);
            return { status: 'published' as const };
        }),
        completeFileSyncAttachmentPublication: vi.fn(async () => undefined),
        abandonFileSyncAttachmentPublication: vi.fn(async () => undefined),
        retainFileSyncAttachmentPublicationForInvalidTarget: vi.fn(async () => undefined),
        clearFileSyncAttachmentPublicationRecovery: vi.fn(async () => undefined),
    };


    const up: Attachment = {
        id: 'up', kind: 'file', title: 'up.txt', uri: UP_URI, localStatus: 'available', size: UP.byteLength,
        createdAt: STAMP, updatedAt: STAMP, ...(cell.hashed ? { fileHash: await sha(UP) } : {}),
    };
    const downBase: Attachment = { id: 'down', kind: 'file', title: 'down.txt', uri: '', localStatus: 'missing', size: DOWN.byteLength, createdAt: STAMP, updatedAt: STAMP };
    world.downKey = cell.backend === 'file' ? buildFileSyncGenerationCloudKey(downBase, await sha(DOWN)) : 'attachments/down.txt';
    const down: Attachment = { ...downBase, cloudKey: world.downKey, ...(cell.hashed ? { fileHash: await sha(DOWN) } : {}) };
    world.upKey = cell.backend === 'file' ? buildFileSyncGenerationCloudKey(up, await sha(UP)) : 'attachments/up.txt';
    memory.put(UP_URI, UP);
    if (cell.backend === 'file') memory.put(`${FOLDER}${world.downKey.split('/').pop()}`, DOWN);
    else store(world.downKey, DOWN);
    world.remoteDoc = doc([task('t-down', down)]);
    await new SqliteAdapter(client).saveData(doc([task('t-up', up)]));
    return { world, installer, core };
};
type World = Awaited<ReturnType<typeof createWorld>>;


const remoteBytes = (w: World, key: string) => (w.world.cell.backend === 'file'
    ? w.world.memory.read(`${FOLDER}${key.split('/').pop()}`)
    : w.world.blobs.get(key)?.data);


const startDevice = async (w: World) => {
    const { world } = w;

    const mortal = <T extends object>(target: T): T => new Proxy(target, {
        get: (object, property, receiver) => {
            const value = Reflect.get(object, property, receiver);
            return typeof value === 'function'
                ? (...args: unknown[]) => { if (world.dead) throw new Error('the process is dead'); return value.apply(object, args); }
                : value;
        },
    });
    const installer = mortal(w.installer);
    const core = mortal(w.core);
    const { log, lines } = createRecordingLog();
    const fs = mortal(world.memory.fs);
    const files = createMobileAttachmentFiles({
        fs, storage: mortal(world.storage), getSecureConfigValue: async () => null, log,
        fetch: vi.fn() as unknown as typeof fetch,
        dropboxAuth: { getValidAccessToken: async () => 'token', forceRefreshAccessToken: async () => 'token' },
        core: { isSandboxMode: () => false },
    });
    const common = createMobileAttachmentCommon({
        fs, files, installer, crypto: {} as never, encryption: { logSyncEncryptionEvent: async () => undefined },
        installerMayBeMissing: () => false, timersPaused: () => true, uploads: { createUploadTask: () => null },
    });

    const backends = createMobileAttachmentBackends({ fs, files, common, installer, log, core, boundedWebdavResponses: true });
    const adapter = new SqliteAdapter(world.client, { rejectConcurrentWrites: true });
    let inMemory = await adapter.getData();
    const warnings: string[] = [];

    const syncAttachments = (data: AppData, helpers: SyncRunAttachmentHelpers) => {
        const options = {
            phase: helpers.phase, activationProbe: helpers.activationProbe, transferAdmission: helpers.transferAdmission,
            assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
        };
        switch (world.cell.backend) {
            case 'webdav': return backends.syncWebdavAttachments(data, { url: `${DAV}/data.json`, username: 'u', password: 'p' }, DAV, undefined, options);
            case 'cloud': return backends.syncCloudAttachments(data, { url: `${CLOUD}/data`, token: 't' }, CLOUD,
                { ...options, assertCurrent: () => helpers.ensureLocalSnapshotFresh() });
            case 'dropbox': return backends.syncDropboxAttachments(data, 'app', vi.fn() as unknown as typeof fetch,
                { ...options, resolveAccessToken: async () => 'token' });
            case 'file': return backends.syncFileAttachments(data, SYNC_PATH, undefined, options);
        }
    };
    let docVersion = 0;
    const io: SyncBackendIO = {
        readRemote: async () => (world.remoteDoc ? cloneAppData(world.remoteDoc) : null),
        writeRemote: async (data) => {
            if (attachmentsOf(data).get('up')?.cloudKey) world.upBlobAtDocWrite.push(remoteBytes(w, attachmentsOf(data).get('up')!.cloudKey!)?.slice());
            world.remoteDoc = cloneAppData(data);
            docVersion += 1;
            return { fingerprint: `doc-${docVersion}` };
        },
        readRemoteFingerprint: async () => (world.remoteDoc ? `doc-${docVersion}` : null),
        syncAttachments,
    };


    const run = async (refuse: boolean): Promise<SyncRunResult> => {
        world.cycle += 1;
        let saves = 0;
        return runSharedSyncCycle({
            options: {},
            storage: {
                readPersistedLocal: (options) => adapter.getData(options),
                persistLocal: async (data, options) => {
                    saves += 1;
                    if (refuse && saves === 1) {
                        await adapter.upsertCalendarSyncEntry({ taskId: 't-up', calendarEventId: `e-${world.cycle}`, calendarId: 'c', platform: 'android', lastSyncedAt: STAMP });
                    }
                    await adapter.saveData(data, options);
                },
                persistSyncStatus: async () => undefined,
                readTokenOf: (data) => adapter.readTokenOf(data),
                readFastSyncState: async () => null,
                writeFastSyncState: async () => undefined,
                injectExternalCalendars: async (data) => data,
                persistExternalCalendars: async () => undefined,
                applyDataToStore: (data) => { inMemory = cloneAppData(data); },
            },
            notifier: {
                setStep: () => undefined,
                logInfo: () => undefined,
                logWarning: (message, error) => { warnings.push(`${message}: ${error instanceof Error ? error.message : String(error ?? '')}`); },
                logWarningExtra: (message) => { warnings.push(message); },
                sanitizeLogMessage: (message) => message,
                logSyncError: async () => null,
                logMergeSummary: () => undefined,

                sliceYield: async () => undefined,
            },
            store: {
                getLastDataChangeAt: () => 1,
                getInMemorySnapshot: () => cloneAppData(inMemory),
                captureInMemorySnapshot: () => ({
                    tasks: [...inMemory.tasks], projects: [...inMemory.projects], sections: [...inMemory.sections],
                    areas: [...inMemory.areas], people: [...(inMemory.people ?? [])], settings: inMemory.settings,
                }),
                flushPendingSave: async () => undefined,
                setUiError: () => undefined,
                getSettings: () => inMemory.settings,
            },
            hooks: {
                setupCycle: async () => ({
                    kind: 'ready' as const,
                    backend: world.cell.backend === 'dropbox' ? 'cloud' : world.cell.backend,
                    cloudProvider: world.cell.backend === 'dropbox' ? 'dropbox' as const : 'selfhosted' as const,
                    io,
                    fastSyncScope: null,
                }),
                requestFollowUp: () => undefined,
                requestFollowUpAfter: () => undefined,
                formatErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
                finalizeErrorStatus: async () => undefined,
                finalizeSuccess: async () => undefined,

                shouldRunAttachmentPhase: (data) => files.hasPendingAttachmentSyncWork(data, { contentCheckEnabled: true }),
            },

            policy: {
                preSyncAttachmentsBeforeFastCheck: true,
                enableReadCheckSkip: false,
                postMergeAttachmentErrorPolicy: 'fail',
                attachmentPhasesEnabled: true,
            },
            now: () => new Date(),
        });
    };
    return { run, adapter, backends, files, lines, warnings };
};

const downloadsInSync = (cell: Cell) => cell.backend === 'webdav' || cell.backend === 'dropbox';

const transfersOf = (w: World, filter: Partial<Transfer>) => w.world.transfers.filter((t) => (
    (filter.cycle === undefined || t.cycle === filter.cycle) && (filter.id === undefined || t.id === filter.id) && (filter.dir === undefined || t.dir === filter.dir)));


const expectBoundedTransfers = (w: World) => {
    const counts = new Map<string, number>();
    for (const t of w.world.transfers) counts.set(`${t.cycle}|${t.id}|${t.dir}`, (counts.get(`${t.cycle}|${t.id}|${t.dir}`) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
};


const expectNoWrongBytes = async (w: World, data: AppData) => {
    for (const attachment of attachmentsOf(data).values()) {
        if (attachment.localStatus !== 'available' || !attachment.uri) continue;
        const local = w.world.memory.read(attachment.uri);
        expect(local, attachment.id).toBeDefined();
        if (attachment.fileHash) expect(await sha(local!), attachment.id).toBe(attachment.fileHash);
    }
};

describe('design D9b W7 per backend: three refused saves, then a restart', () => {
    it.each(table(CELLS))('%s: transfers stay bounded, bytes stay right, and the state converges', async (_name, cell) => {
        const w = await createWorld(cell);
        let device = await startDevice(w);
        for (let index = 0; index < 3; index += 1) {
            const result = await device.run(true);
            expect(result, device.warnings.join('\n')).toMatchObject({ success: true, skipped: 'requeued' });
            await expectNoWrongBytes(w, await device.adapter.getData());
            expectBoundedTransfers(w);
        }

        expect(w.world.upBlobAtDocWrite).toEqual([]);

        device = await startDevice(w);
        const final = await device.run(false);
        expect(final, device.warnings.join('\n')).toMatchObject({ success: true });
        expect(final.skipped).toBeUndefined();
        expectBoundedTransfers(w);

        const local = await device.adapter.getData();
        expect(local.settings.pendingRemoteWriteAt).toBeUndefined();
        await expectNoWrongBytes(w, local);
        const up = attachmentsOf(local).get('up')!;
        const down = attachmentsOf(local).get('down')!;
        expect(up).toMatchObject({ localStatus: 'available', uri: UP_URI, cloudKey: w.world.upKey, fileHash: await sha(UP) });
        if (!downloadsInSync(cell)) {

            expect(down).toMatchObject({ cloudKey: w.world.downKey, localStatus: 'missing' });
            expect(w.world.memory.calls.filter((call) => call.startsWith(`copy ${FOLDER}`))).toEqual([]);
        } else {
            expect(down).toMatchObject({ localStatus: 'available', uri: DOWN_TARGET, cloudKey: w.world.downKey, fileHash: await sha(DOWN) });
            expect(w.world.memory.read(DOWN_TARGET)).toEqual(DOWN);
        }

        expect(remoteBytes(w, w.world.upKey)).toEqual(UP);
        expect(remoteBytes(w, w.world.downKey)).toEqual(DOWN);
        const remote = attachmentsOf(w.world.remoteDoc!);
        expect(remote.get('up')).toMatchObject({ cloudKey: w.world.upKey, fileHash: await sha(UP) });
        expect(remote.get('down')).toMatchObject({ cloudKey: w.world.downKey });
        expect(w.world.upBlobAtDocWrite.every((data) => data !== undefined && Buffer.from(data).equals(Buffer.from(UP)))).toBe(true);


        const unversioned = cell.backend === 'webdav' && cell.etag !== 'strong';
        expect(transfersOf(w, { id: 'up', dir: 'put' })).toHaveLength(cell.backend === 'file' || unversioned ? 1 : 4);
        expect(transfersOf(w, { id: 'up', dir: 'get' })).toHaveLength(unversioned ? 3 : 0);


        expect(transfersOf(w, { id: 'down', dir: 'get' })).toHaveLength(!downloadsInSync(cell) ? 0 : cell.hashed ? 1 : 4);
        if (cell.hashed && downloadsInSync(cell)) {
            expect(device.lines.some((line) => line.extra?.releaseCheck === 'v1.3.7/attachment-download-reuse')).toBe(true);
        }
    });
});

const DOWNLOAD_CELLS = CELLS.filter((cell) => downloadsInSync(cell) && cell.hashed && cell.etag === 'strong');

describe('design D9b W7: a file at the download target', () => {
    it.each(table(DOWNLOAD_CELLS))('%s: a matching file costs zero GETs; a mismatching one is never adopted', async (_name, cell) => {
        for (const present of [DOWN, WRONG]) {
            const w = await createWorld(cell);
            w.world.memory.put(DOWN_TARGET, present);
            const device = await startDevice(w);
            expect(await device.run(false)).toMatchObject({ success: true });
            const local = await device.adapter.getData();
            await expectNoWrongBytes(w, local);
            const down = attachmentsOf(local).get('down')!;
            if (present === DOWN) {
                expect(transfersOf(w, { id: 'down', dir: 'get' })).toHaveLength(0);
                expect(down).toMatchObject({ localStatus: 'available', uri: DOWN_TARGET });
            } else {

                expect(transfersOf(w, { id: 'down', dir: 'get' })).toHaveLength(1);
                expect(down.localStatus === 'available' && down.uri === DOWN_TARGET).toBe(false);
                expect(w.world.memory.read(DOWN_TARGET)).toEqual(WRONG);
            }
        }
    });
});

describe('design D9b W7: the process dies inside a download install (crash point A2)', () => {
    const cells = CELLS.filter((cell) => downloadsInSync(cell) && cell.etag === 'strong');
    it.each(table(cells))('%s: the staged file is never adopted or recorded, and the next start GETs again and converges', async (_name, cell) => {
        const w = await createWorld(cell);
        const install = w.installer.installAttachmentFileGeneration.getMockImplementation()!;


        w.installer.installAttachmentFileGeneration.mockImplementationOnce(async () => {
            w.world.dead = true;
            throw new Error('the process died');
        });
        await (await startDevice(w)).run(false).catch(() => undefined);
        expect(w.world.dead).toBe(true);
        expect(w.world.memory.read(DOWN_TARGET)).toBeUndefined();
        expect(transfersOf(w, { id: 'down', dir: 'get' })).toHaveLength(1);

        w.world.dead = false;
        w.installer.installAttachmentFileGeneration.mockImplementation(install);
        const restarted = await startDevice(w);

        await expectNoWrongBytes(w, await restarted.adapter.getData());
        expect(await restarted.run(false), restarted.warnings.join('\n')).toMatchObject({ success: true });
        const local = await restarted.adapter.getData();
        await expectNoWrongBytes(w, local);
        expect(transfersOf(w, { id: 'down', dir: 'get' })).toHaveLength(2);
        expect(attachmentsOf(local).get('down')).toMatchObject({ localStatus: 'available', uri: DOWN_TARGET });
        expect(w.world.memory.read(DOWN_TARGET)).toEqual(DOWN);
    });
});

describe('design D9b W7: another writer replaces the uploaded blob right after our PUT', () => {
    const cells = CELLS.filter((cell) => cell.hashed);
    it.each(table(cells))('%s: the next cycle PUTs A again before anything references it, and never records B', async (_name, cell) => {
        const w = await createWorld(cell);
        const device = await startDevice(w);

        let replaced = false;
        w.world.onTransfer = (transfer) => {
            if (replaced || transfer.id !== 'up' || transfer.dir !== 'put') return;
            replaced = true;
            if (cell.backend === 'file') w.world.memory.put(`${FOLDER}${w.world.upKey.split('/').pop()}`, OTHER);
            else w.world.blobs.set(w.world.upKey, { data: OTHER, version: w.world.blobs.get(w.world.upKey)!.version + 1 });
        };
        expect(await device.run(true)).toMatchObject({ success: true, skipped: 'requeued' });
        expect(replaced).toBe(true);
        expect(transfersOf(w, { id: 'up', dir: 'put' })).toHaveLength(1);
        w.world.onTransfer = undefined;

        const result = await device.run(false);

        const local = await device.adapter.getData();
        await expectNoWrongBytes(w, local);
        expect(w.world.memory.read(UP_URI)).toEqual(UP);
        expect(attachmentsOf(local).get('up')?.fileHash).toBe(await sha(UP));

        expect(w.world.upBlobAtDocWrite.every((data) => data !== undefined && Buffer.from(data).equals(Buffer.from(UP)))).toBe(true);
        if (cell.backend === 'file' || (cell.backend === 'webdav' && cell.etag !== 'strong')) {


            expect(result.success).toBe(false);
            expect(attachmentsOf(local).get('up')?.cloudKey).toBeUndefined();
            expect(attachmentsOf(w.world.remoteDoc!).has('up')).toBe(false);
            return;
        }
        expect(result, device.warnings.join('\n')).toMatchObject({ success: true });
        expect(transfersOf(w, { id: 'up', dir: 'put', cycle: 2 })).toHaveLength(1);
        expect(remoteBytes(w, w.world.upKey)).toEqual(UP);
        expect(w.world.upBlobAtDocWrite.length).toBeGreaterThan(0);
    });
});

describe('design D9b W7: one transfer per attachment and direction across a cycle\'s phases (c2 P3-3)', () => {
    it.each(table(DOWNLOAD_CELLS))('%s: a GET whose answer is lost is not sent again by a later phase of the same cycle', async (_name, cell) => {
        const w = await createWorld(cell);
        const device = await startDevice(w);
        w.world.onTransfer = (t) => { if (t.cycle === 1 && t.id === 'down' && t.dir === 'get') throw httpError(500); };
        await device.run(false);
        expect(transfersOf(w, { id: 'down', dir: 'get', cycle: 1 })).toHaveLength(1);

        w.world.onTransfer = undefined;
        const restarted = await startDevice(w);
        expect(await restarted.run(false)).toMatchObject({ success: true });
        expect(transfersOf(w, { id: 'down', dir: 'get', cycle: 2 })).toHaveLength(1);
        expect(attachmentsOf(await restarted.adapter.getData()).get('down')).toMatchObject({ localStatus: 'available', uri: DOWN_TARGET });
    });


    it('Dropbox: a PUT whose answer is lost is sent once per cycle admission', async () => {
        const w = await createWorld({ backend: 'dropbox', hashed: true, etag: 'strong' });
        const device = await startDevice(w);
        w.world.onTransfer = (t) => { if (t.dir === 'put') throw httpError(500); };
        const data = await device.adapter.getData();
        const call = (transferAdmission: ReturnType<typeof createAttachmentTransferAdmission>) => device.backends.syncDropboxAttachments(
            data, 'app', vi.fn() as unknown as typeof fetch, { phase: 'post-merge', transferAdmission, resolveAccessToken: async () => 'token' });
        const cycle = createAttachmentTransferAdmission();
        await call(cycle);
        await call(cycle);
        expect(transfersOf(w, { id: 'up', dir: 'put' })).toHaveLength(1);
        await call(createAttachmentTransferAdmission());
        expect(transfersOf(w, { id: 'up', dir: 'put' })).toHaveLength(2);
    });

    it('File Sync: a publication whose acknowledgment is lost is not attempted again in the same cycle', async () => {
        const w = await createWorld({ backend: 'file', hashed: true, etag: 'strong' });
        const device = await startDevice(w);
        w.world.onTransfer = (t) => { if (t.dir === 'put') throw new Error('acknowledgment lost'); };
        const data = await device.adapter.getData();
        const target = `${FOLDER}${w.world.upKey.split('/').pop()}`;
        const touches = () => w.world.memory.calls.filter((c) => c.includes(target)).length;
        const call = (transferAdmission: ReturnType<typeof createAttachmentTransferAdmission>) => device.backends.syncFileAttachments(
            data, SYNC_PATH, undefined, { phase: 'post-merge', transferAdmission });
        const cycle = createAttachmentTransferAdmission();
        await call(cycle);
        expect(w.world.memory.read(target)).toEqual(UP);
        const afterFirst = touches();
        const second = await call(cycle);
        expect(touches()).toBe(afterFirst);
        expect(second === false ? undefined : attachmentsOf(second).get('up')?.cloudKey).toBeUndefined();

        w.world.onTransfer = undefined;
        const next = await call(createAttachmentTransferAdmission());
        expect(next === false ? undefined : attachmentsOf(next).get('up')?.cloudKey).toBe(w.world.upKey);
        expect(transfersOf(w, { id: 'up', dir: 'put' })).toHaveLength(1);
    });
});
