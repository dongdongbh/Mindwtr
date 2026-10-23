import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import { createMobileSyncService, type MobileSyncServiceHost } from './mobile-sync-service';
import { flushPendingSave, resetForTests, setStorageAdapter, STORE_NON_COMMAND_KEYS, useTaskStore } from './store';
import { getInMemoryAppDataSnapshot } from './sync-client-helpers';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { performSyncCycle } from './sync';
import { createNativeHostContract, NATIVE_CONTRACT_NETWORK_READS, NATIVE_CONTRACT_SYNC_SCREEN_METHODS, NATIVE_CONTRACT_UNGATED_METHODS } from './native-host-contract';
import { createCalendarSubscriptionAddMethods } from './native-host-contract-calendar-subscription-add';
import { createCalendarSubscriptionSettingsMethods } from './native-host-contract-calendar-subscription-settings';
import { createDeviceCalendarSettingsMethods } from './native-host-contract-device-calendar-settings';
import { createPreparedProjectAvailabilityMethods, createProjectAvailabilityMethods } from './native-host-contract-project-availability';
import { isStoreCommand } from './store-write-gate';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts, revisionOf } from './native-request-receipts';
import { CLOUD_PROVIDER_KEY, CLOUD_TOKEN_KEY, CLOUD_URL_KEY, SYNC_BACKEND_KEY } from './sync-storage-keys';
import { createSyncEncryptionStateStore } from './sync-encryption-local-state';
import type { AppData, Project, Task } from './types';

// A command that lands while a sync cycle waits on the network, after its first local save,
// must act on what that save wrote: the store must not lag the disk (D9b change 0).
const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
}; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const NEWER = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const task = (extra: Partial<Task>): Task => ({
    id: 'shared', title: 'old', status: 'next', tags: [], contexts: [], createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'this-device',
    ...extra,
} as Task);
const project = (extra: Partial<Project>): Project => ({
    id: 'starred', title: 'Project', status: 'active', color: '#94a3b8', order: 0, tagIds: [], isFocused: false,
    createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'this-device', ...extra,
} as Project);
const doc = (tasks: Task[], settings: AppData['settings'] = {}, projects: Project[] = []): AppData => ({ tasks, projects, sections: [], areas: [], people: [], settings });

const databases: Database[] = [];

async function openStore(guarded: boolean, receipts = false, extraTasks: Task[] = []) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(':memory:'); databases.push(db);
    const client: SqliteClient = {
        run: async (sql, params = []) => { db.prepare(sql).run(...params); },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)[0] as T | undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    await new SqliteAdapter(client).saveData(doc([task({}), ...extraTasks], { deviceId: 'this-device' }, [project({})]));
    const options = guarded ? { rejectConcurrentWrites: true } : {};
    const adapter = receipts ? new NativeReceiptSqliteAdapter(client, options) : new SqliteAdapter(client, options);
    setStorageAdapter(adapter);
    // A load never drops rows the store holds (its partial-snapshot guard): start each database on an empty store.
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} });
    await useTaskStore.getState().fetchData({ silent: true });
    return adapter;
}

function createHost(adapter: SqliteAdapter, remote: AppData, sliced = false) {
    const values = new Map<string, string>([
        [SYNC_BACKEND_KEY, 'cloud'], [CLOUD_PROVIDER_KEY, 'selfhosted'], [CLOUD_URL_KEY, 'https://cloud.example.test'],
    ]);
    const storage = {
        getItem: vi.fn(async (key: string) => values.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { values.delete(key); }),
    };
    let releasePut: () => void = () => undefined;
    const held: { start: () => void } = { start: () => undefined };
    const putStarted = new Promise<void>((started) => {
        held.start = started;
    });
    const put = vi.fn(async () => {
        if (put.mock.calls.length > 1) return { fingerprint: 'remote-after-put' };
        held.start();
        await new Promise<void>((release) => { releasePut = release; });
        return { fingerprint: 'remote-after-put' };
    });
    const lease = { lost: false };
    const logs: { message: string; extra?: Record<string, string> }[] = [];
    const encryption = createSyncEncryptionStateStore({
        storage,
        secureConfig: { getSecureConfigValue: async () => null, setSecureConfigValue: async () => undefined, deleteSecureConfigValue: async () => undefined },
        readActiveScope: async () => null,
        log: { info: () => undefined, warn: () => undefined },
    });
    const host = {
        storage,
        encryption,
        fileSync: {
            readVersioned: async () => ({ data: JSON.parse(JSON.stringify(remote)), fingerprint: 'file:v1:remote', needsRepair: false }),
            write: async () => undefined,
            resolveUri: async (uri: string) => uri,
            isBookmarksAvailable: () => false,
            resolveBookmark: async () => null,
            acquireLease: async () => ({ token: 'lease' }),
            revalidateLease: async () => { if (lease.lost) throw new Error('File Sync lease lost'); },
            releaseLease: async () => undefined,
        },
        getSecureConfigValue: async (key: string) => (key === CLOUD_TOKEN_KEY ? 'token' : null),
        platform: { os: () => 'android', isFossBuild: false, dropboxAppKey: () => '' },
        network: {
            getState: async () => ({ isConnected: true, isInternetReachable: true, isAirplaneModeEnabled: false }),
            subscribe: () => ({ remove: () => undefined }),
        },
        localData: { getData: () => adapter.getData(), saveData: (data: AppData) => adapter.saveData(data) },
        // Native Android's sliced cycles (D9b): token-checked reads and saves, rows prepared before the gate.
        ...(sliced ? {
            sliceYield: async () => undefined,
            localData: {
                getData: (options?: SaveOptions) => adapter.getData(options),
                saveData: (data: AppData, options?: SaveOptions) => adapter.saveData(data, options),
                readTokenOf: (data: AppData) => adapter.readTokenOf(data),
                prepareSave: (data: AppData) => adapter.prepareSaveRows(data),
            },
        } : {}),
        log: {
            info: (message: string, context?: { extra?: Record<string, string> }) => { logs.push({ message, extra: context?.extra }); },
            warn: () => undefined, syncError: async () => null, sanitize: (message: string) => message,
        },
        externalCalendars: { load: async () => [], save: async () => undefined },
        fetch: vi.fn(async () => { throw new Error('no network in tests'); }),
        crypto: {},
        attachments: {
            syncWebdav: async () => false, syncCloud: async () => false, syncDropbox: async () => false, syncFile: async () => false,
            cleanupTempFiles: async () => undefined, hasCompletedPresenceReconciliation: async () => false,
            hasPendingWork: async () => false, runCleanup: async ({ appData }: { appData: AppData }) => ({ appData, shouldInvalidateFastSyncState: false }),
        },
        core: {
            useTaskStore, flushPendingSave, getInMemoryAppDataSnapshot, performSyncCycle,
            isSandboxMode: () => false, isWorkspaceTransitionActive: () => false,
            withRetry: async <T,>(operation: () => Promise<T>) => operation(),
            cloudGetJson: vi.fn(async () => JSON.parse(JSON.stringify(remote))),
            cloudPutJson: put,
            acquireSyncRemoteMutationFence: vi.fn(async () => ({
                assertHeld: async () => undefined, renew: async () => undefined, release: async () => undefined,
            })),
        },
    } as unknown as MobileSyncServiceHost<unknown>;
    return { host, putStarted, releasePut: () => releasePut(), put, lease, logs };
}

type SaveOptions = Parameters<SqliteAdapter['saveData']>[1];

const runCycle = async (service: ReturnType<typeof createMobileSyncService>) => {
    const result = await service.performMobileSync(undefined, { manual: true });
    service.__mobileSyncTestUtils.clearFollowUpForTests();
    await flushPendingSave();
    return result;
};

const winner = () => doc([task({ title: 'winner', rev: 2, revBy: 'other-device', updatedAt: NEWER })], {},
    [project({ isFocused: true, rev: 2, revBy: 'other-device', updatedAt: NEWER })]);

describe.each([[false, false], [true, false], [true, true]])('a command during the remote write (guarded adapter: %s, sliced: %s)', (guarded, sliced) => {
    beforeEach(() => { vi.useRealTimers(); });
    afterEach(async () => {
        await flushPendingSave(); resetForTests();
        for (const db of databases.splice(0)) db.close();
    });

    it('acts on the merged row, so the remote title survives the completion', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        const service = createMobileSyncService(fake.host);
        const cycle = service.performMobileSync(undefined, { manual: true });
        try {
            await fake.putStarted;
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await flushPendingSave();
            fake.releasePut();
            await cycle;
            service.__mobileSyncTestUtils.clearFollowUpForTests();
            await flushPendingSave();
            const saved = (await adapter.getData()).tasks.find((row) => row.id === 'shared');
            expect(saved?.status).toBe('done');
            expect(saved?.title).toBe('winner');
        } finally {
            fake.releasePut();
            await cycle.catch(() => undefined);
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('keeps the pending remote-write marker through a settings command', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        const service = createMobileSyncService(fake.host);
        const cycle = service.performMobileSync(undefined, { manual: true });
        try {
            await fake.putStarted;
            await useTaskStore.getState().updateSettings({ theme: 'dark' });
            await flushPendingSave();
            const during = (await adapter.getData()).settings;
            expect(during.theme).toBe('dark');
            expect(during.pendingRemoteWriteAt).toBeTruthy();
            fake.releasePut();
            await cycle;
            service.__mobileSyncTestUtils.clearFollowUpForTests();
            await flushPendingSave();
            const after = (await adapter.getData()).settings;
            expect(after.theme).toBe('dark');
            // The cycle ended on a stale exit after its remote write: the marker stays for the next cycle to settle.
            expect(after.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            fake.releasePut();
            await cycle.catch(() => undefined);
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('defers a command that arrives between the first save commit and its store publish', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let command: Promise<unknown> | null = null;
        fake.host.localData.saveData = async (data: AppData, options?: SaveOptions) => {
            await adapter.saveData(data, options);
            // The commit has landed; the cycle has not published it yet.
            command ??= useTaskStore.getState().updateTask('shared', { status: 'done' });
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            await command;
            await flushPendingSave();
            const saved = (await adapter.getData()).tasks.find((row) => row.id === 'shared');
            expect(saved?.status).toBe('done');
            expect(saved?.title).toBe('winner');
            expect((await adapter.getData()).settings.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('publishes the committed document before a lease check after the commit fails', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        fake.host.localData.saveData = async (data: AppData, options?: SaveOptions) => {
            await adapter.saveData(data, options);
            // The rows are committed; the File Sync lease check that follows the save now fails.
            fake.lease.lost = true;
        };
        const service = createMobileSyncService(fake.host);
        try {
            const result = await service.performMobileSync(undefined, {
                manual: true, configOverride: { backend: 'file', syncPath: 'file:///sync/data.json' },
            });
            service.__mobileSyncTestUtils.clearFollowUpForTests();
            expect(result).toMatchObject({ success: false, error: 'Error: File Sync lease lost' });
            expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('winner');
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await useTaskStore.getState().updateSettings({ theme: 'dark' });
            await flushPendingSave();
            const saved = await adapter.getData();
            expect(saved.tasks.find((row) => row.id === 'shared')).toMatchObject({ title: 'winner', status: 'done' });
            expect(saved.settings.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('lets a load that began before a sync save publish only before that save', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let releaseRead!: () => void;
        const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
        let holdNextStoreRead = true;
        const read = adapter.getData.bind(adapter);
        adapter.getData = async (...args: Parameters<typeof adapter.getData>) => {
            const rows = await read(...args);
            if (holdNextStoreRead) {
                holdNextStoreRead = false;
                // The load read the old rows; it publishes them only after this point.
                await readHeld;
            }
            return rows;
        };
        const load = useTaskStore.getState().fetchData({ silent: true });
        await Promise.resolve();
        const service = createMobileSyncService(fake.host);
        try {
            const cycle = runCycle(service);
            await new Promise((resolve) => setTimeout(resolve, 20));
            releaseRead();
            await Promise.all([load, cycle]);
            expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('winner');
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await flushPendingSave();
            expect((await adapter.getData()).tasks.find((row) => row.id === 'shared')).toMatchObject({ title: 'winner', status: 'done' });
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('drops a preloaded snapshot that waited behind a sync save, so the publication of the save stands', async () => {
        const adapter = await openStore(guarded);
        const old = getInMemoryAppDataSnapshot();
        const fake = createHost(adapter, winner(), sliced);
        let load: Promise<void> | null = null;
        let afterLoad: { title?: string; saved?: Task } = {};
        fake.put.mockImplementation(async () => {
            // The remote write follows the save's release of the gate, before the cycle's own end-of-cycle load.
            await load;
            const title = useTaskStore.getState()._tasksById.get('shared')?.title;
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await flushPendingSave();
            afterLoad = { title, saved: (await adapter.getData()).tasks.find((row) => row.id === 'shared') };
            return { fingerprint: 'remote-after-put' };
        });
        fake.host.localData.saveData = async (data: AppData, options?: SaveOptions) => {
            await adapter.saveData(data, options);
            // A reconciliation took this snapshot before the save; its load queues behind the save's hold of the gate.
            load ??= useTaskStore.getState().fetchData({ silent: true, preloadedData: old });
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            expect(afterLoad.title).toBe('winner');
            expect(afterLoad.saved).toMatchObject({ title: 'winner', status: 'done' });
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('admits commands while the cycle runs its attachments phase, after its save released the gate', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let releaseAttachments!: () => void;
        const attachmentsHeld = new Promise<void>((resolve) => { releaseAttachments = resolve; });
        let attachmentsStarted!: () => void;
        const inAttachments = new Promise<void>((resolve) => { attachmentsStarted = resolve; });
        const attachments = fake.host.attachments as unknown as Record<string, unknown>;
        attachments.hasPendingWork = async () => true;
        attachments.syncCloud = async () => { attachmentsStarted(); await attachmentsHeld; return false; };
        const service = createMobileSyncService(fake.host);
        try {
            const cycle = runCycle(service);
            await inAttachments;
            // A slow attachments phase (a backend choice waits behind it in Settings › Sync) holds no gate.
            const answered = await Promise.race([
                useTaskStore.getState().updateSettings({ theme: 'dark' }).then(() => 'answered'),
                new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
            ]);
            expect(answered).toBe('answered');
            releaseAttachments();
            await cycle;
        } finally {
            releaseAttachments();
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('publishes nothing when the save fails before its commit', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner(), sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        fake.host.localData.saveData = async () => { throw new Error('disk full before commit'); };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            // Nothing landed, so the store still shows the disk.
            expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('old');
            expect(useTaskStore.getState().settings.pendingRemoteWriteAt).toBeUndefined();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });
});

describe('a native command during the sync save', () => {
    afterEach(async () => {
        await flushPendingSave(); resetForTests();
        for (const db of databases.splice(0)) db.close();
    });

    it('reads, checks and writes the project star on the published store, never the one the save replaced', async () => {
        const adapter = await openStore(true, true);
        await flushPendingSave();
        const contract = createNativeHostContract();
        const activated = await contract.activate({ writeSafetyReady: true });
        expect(activated).toEqual({ ok: true, value: null });
        await flushPendingSave();
        const shown = revisionOf(useTaskStore.getState()._projectsById.get('starred')!);
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let command: Promise<unknown> | null = null;
        fake.host.localData.saveData = async (data: AppData) => {
            await adapter.saveData(data);
            // The first save has committed the other device's star, inside the sync's hold of the gate.
            command ??= contract.setProjectFocus({ id: 'starred', focused: true, projectRevision: shown });
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            await command;
            await flushPendingSave();
            expect((await adapter.getData()).projects.find((row) => row.id === 'starred')?.isFocused).toBe(true);
            expect(useTaskStore.getState()._projectsById.get('starred')?.isFocused).toBe(true);
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    const failedFirstSave = async (start: (contract: ReturnType<typeof createNativeHostContract>) => Promise<unknown>) => {
        const adapter = await openStore(true, true);
        await flushPendingSave();
        const contract = createNativeHostContract();
        expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        await flushPendingSave();
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let command: Promise<unknown> | null = null;
        fake.host.localData.saveData = async () => {
            // The command arrives while the sync save holds the gate; that save then fails before its commit.
            command ??= start(contract);
            throw new Error('disk full before commit');
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            const reply = await command;
            await flushPendingSave();
            return { reply, saved: await adapter.getData() };
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    };

    it.each([true, false])('sets the project star to %s on the state the failed save left', async (focused) => {
        const { reply, saved } = await failedFirstSave((contract) => contract.setProjectFocus({
            id: 'starred', focused, projectRevision: revisionOf(useTaskStore.getState()._projectsById.get('starred')!),
        }));
        expect(reply).toEqual({ ok: true, value: { id: 'starred', focused } });
        expect(saved.projects.find((row) => row.id === 'starred')?.isFocused ?? false).toBe(focused);
        expect(useTaskStore.getState()._projectsById.get('starred')?.isFocused ?? false).toBe(focused);
    });

    it('applies a receipted task edit, and receipts that it changed, on the state the failed save left', async () => {
        const { reply, saved } = await failedFirstSave((contract) => contract.updateTask({
            id: 'shared', requestId: '22222222-3333-4444-8555-666666666666', base: { title: 'old' }, patch: { title: 'winner' },
        }));
        expect(reply).toEqual({ ok: true, value: { id: 'shared', changed: true } });
        expect(saved.tasks.find((row) => row.id === 'shared')?.title).toBe('winner');
    });

    // A method outside the gate may still answer: its own body reads only the published store and writes none.
    const directStoreWrites = /receipts\.run\(|setState\(|readAreaDurableData|\.getData\(|\.saveData\(|flushPendingSave/;
    const storeActionsNamed = (body: string) => [...body.matchAll(/useTaskStore\.getState\(\)\.(\w+)\(/g)].map((match) => match[1]);

    it('runs every asynchronous contract method as a gated store command', () => {
        const contract = createNativeHostContract() as unknown as Record<string, unknown>;
        const functions = Object.entries(contract).filter(([, value]) => typeof value === 'function');
        for (const [name, method] of functions) {
            if (isStoreCommand(method) || NATIVE_CONTRACT_UNGATED_METHODS.has(name)) continue;
            // An ungated method answers synchronously: it never awaits, and it writes no receipt.
            expect(method.constructor.name, name).not.toBe('AsyncFunction');
            expect(/receipts\.run\(|await /.test(Function.prototype.toString.call(method)), name).toBe(false);
        }
        expect(isStoreCommand(contract.setProjectFocus)).toBe(true);
        expect(isStoreCommand(contract.updateTask)).toBe(true);
        expect(isStoreCommand(contract.setFocusGroupBy)).toBe(true);
        // Add writes the subscriptions to settings; the heartbeat only sends a request.
        expect(isStoreCommand(contract.addCalendarFeed)).toBe(true);
        expect(isStoreCommand(contract.sendAboutHeartbeat)).toBe(false);
        expect(isStoreCommand(contract.syncNow)).toBe(false);
    });

    it('lets only network reads and Settings › Sync bypass the gate, and neither writes the store itself', () => {
        const contract = createNativeHostContract() as unknown as Record<string, unknown>;
        const store = useTaskStore.getState() as unknown as Record<string, unknown>;
        expect([...NATIVE_CONTRACT_UNGATED_METHODS].sort())
            .toEqual([...NATIVE_CONTRACT_NETWORK_READS, ...NATIVE_CONTRACT_SYNC_SCREEN_METHODS].sort());
        for (const name of NATIVE_CONTRACT_UNGATED_METHODS) {
            const body = Function.prototype.toString.call(contract[name]);
            expect(isStoreCommand(contract[name]), name).toBe(false);
            expect(directStoreWrites.test(body), name).toBe(false);
            for (const action of storeActionsNamed(body)) {
                // A network read calls no store writer; the sync screen's writers are store commands.
                if (NATIVE_CONTRACT_NETWORK_READS.has(name)) expect(STORE_NON_COMMAND_KEYS.has(action), `${name} calls ${action}`).toBe(true);
                else expect(STORE_NON_COMMAND_KEYS.has(action) || isStoreCommand(store[action]), `${name} calls ${action}`).toBe(true);
            }
        }
        // The sync screen writes the store through these actions and its receipts' saves, each gated on its own.
        expect(isStoreCommand(store.updateSettings)).toBe(true);
        expect(isStoreCommand(contract.setSyncPreference)).toBe(true);
    });

    it('gates the calendar and Project availability helpers the bridge builds outside the contract', () => {
        const ready = () => ({ ok: true as const, value: null });
        const save = async () => ready();
        const helpers: Record<string, Record<string, unknown>> = {
            deviceCalendar: createDeviceCalendarSettingsMethods({ readiness: ready, storage: () => null }),
            calendarSubscription: createCalendarSubscriptionSettingsMethods({ readiness: ready, save, storage: () => null, model: () => { throw new Error('unused'); } }),
            calendarSubscriptionAdd: createCalendarSubscriptionAddMethods({ readiness: ready, save, storage: () => null }),
            projectAvailability: createProjectAvailabilityMethods({ readiness: ready, revision: () => '', save, host: () => null }),
            preparedProjectAvailability: createPreparedProjectAvailabilityMethods({ readiness: ready, revision: () => '', save }),
        };
        for (const [helper, methods] of Object.entries(helpers)) {
            for (const [name, method] of Object.entries(methods)) {
                if (typeof method !== 'function' || isStoreCommand(method)) continue;
                expect(method.constructor.name, `${helper}.${name}`).not.toBe('AsyncFunction');
                expect(/receipts\.run\(|await /.test(Function.prototype.toString.call(method)), `${helper}.${name}`).toBe(false);
            }
        }
        expect(isStoreCommand(helpers.calendarSubscription.prepareCalendarSubscriptionSetting)).toBe(true);
        expect(isStoreCommand(helpers.deviceCalendar.prepareDeviceCalendarSetting)).toBe(true);
        expect(isStoreCommand(helpers.calendarSubscriptionAdd.commitPreparedCalendarSubscriptionAdd)).toBe(true);
        expect(isStoreCommand(helpers.preparedProjectAvailability.commitPreparedProjectFileAvailability)).toBe(true);
    });
});

// D9b W6 (design §3, §7): a sliced cycle builds its save rows and its store publish before the gate; the gate swaps the
// publish in only onto the store it was built against, and the end-of-cycle refresh is dropped only when it changes nothing.
describe('a sliced cycle\'s prepared rows, prepared swap and refresh drop', () => {
    let now: { mockRestore: () => void } | null = null;
    beforeEach(() => {
        vi.useRealTimers();
        // Every slice is due at once, so each pass yields at every point it may.
        let clock = 0;
        now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    });
    afterEach(async () => {
        now?.mockRestore();
        await flushPendingSave(); resetForTests();
        for (const db of databases.splice(0)) db.close();
    });

    const other = task({ id: 'other', title: 'on disk' });
    /** Runs [act] once, at the [nth] slice yield after the first save's rows were prepared. */
    const afterRowsPrepared = (fake: ReturnType<typeof createHost>, adapter: SqliteAdapter, nth: number, act: () => Promise<unknown> | unknown) => {
        let yieldsSincePrepared = -1;
        fake.host.localData.prepareSave = (data: AppData) => (function* () {
            yield* adapter.prepareSaveRows(data);
            if (yieldsSincePrepared < 0) yieldsSincePrepared = 0;
            yield;
        })();
        fake.host.sliceYield = async () => {
            if (yieldsSincePrepared < 0) return;
            yieldsSincePrepared += 1;
            if (yieldsSincePrepared === nth) await act();
        };
    };
    const published = (fake: ReturnType<typeof createHost>) => fake.logs.find((line) => line.message === 'Sync cycle ran in slices')?.extra;

    it('swaps in the prepared publish, and the store then equals disk', async () => {
        const adapter = await openStore(true, false, [other]);
        const fake = createHost(adapter, winner(), true);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        const service = createMobileSyncService(fake.host);
        try {
            expect((await runCycle(service)).success).toBe(true);
            expect(published(fake)?.storePublish).toMatch(/^prepared(,prepared)+$/);
            const disk = await adapter.getData();
            const state = useTaskStore.getState();
            expect(state._allTasks).toEqual(disk.tasks);
            expect(state._allProjects).toEqual(disk.projects);
            expect(state._tasksById.get('shared')?.title).toBe('winner');
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('refuses the sync save when a command lands between the preparation and the gate, and keeps the command\'s row', async () => {
        const adapter = await openStore(true);
        const fake = createHost(adapter, winner(), true);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        afterRowsPrepared(fake, adapter, 1, () => useTaskStore.getState().updateTask('shared', { title: 'edited here' }));
        const service = createMobileSyncService(fake.host);
        try {
            const result = await runCycle(service);
            expect(result).toMatchObject({ success: true, skipped: 'requeued' });
            expect(fake.put).not.toHaveBeenCalled();
            const saved = (await adapter.getData()).tasks.find((row) => row.id === 'shared');
            expect(saved?.title).toBe('edited here');
            expect(saved?.revBy).toBe('this-device');
            expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('edited here');
            expect((await adapter.getData()).settings.pendingRemoteWriteAt).toBeUndefined();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('computes the publish in the gate when the store moved after the preparation without a new stamp or token', async () => {
        // More rows than one slice holds, so the publish's preparation yields after it has taken the store's references.
        const filler = Array.from({ length: 80 }, (_, index) => task({ id: `filler-${index}`, title: `Filler ${index}` }));
        const adapter = await openStore(true, false, [other, ...filler]);
        // The store shows a copy of 'other' that disk does not hold, at the same revision. A change during the
        // preparation (as a load would make: no stamp, no write) shows disk's row again.
        const diskOther = useTaskStore.getState()._tasksById.get('other')!;
        const withOther = (row: Task) => (state: { _allTasks: Task[] }) => ({ _allTasks: state._allTasks.map((item) => (item.id === 'other' ? row : item)) });
        useTaskStore.setState(withOther({ ...diskOther, title: 'stale copy' }));
        const stamp = useTaskStore.getState().lastDataChangeAt;
        const fake = createHost(adapter, winner(), true);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        // The second yield after the rows: the publish's preparation has taken the store's references by then.
        afterRowsPrepared(fake, adapter, 2, () => useTaskStore.setState(withOther(diskOther)));
        const service = createMobileSyncService(fake.host);
        try {
            expect(await runCycle(service)).toMatchObject({ success: true });
            expect(useTaskStore.getState().lastDataChangeAt).toBe(stamp);
            expect(published(fake)?.storePublish).toMatch(/^in-gate(,prepared)+$/);
            const disk = await adapter.getData();
            expect(useTaskStore.getState()._allTasks).toEqual(disk.tasks);
            expect(useTaskStore.getState()._tasksById.get('other')?.title).toBe('on disk');
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    // fetchData keeps no row object across a recovery load and the normal load after it (store-settings.ts reuseEntities).
    it.each([false, true])('keeps the load-normalized rows after a recovery load, through a cycle and a later store save (sliced: %s)', async (sliced) => {
        const adapter = await openStore(true, false, [task({ id: 'raw', title: 'Raw row' })]);
        // A row the load normalizes without a new revision (an invalid time spent), then a recovery load: the raw rows.
        await flushPendingSave();
        const disk = await adapter.getData();
        await adapter.saveData({ ...disk, tasks: disk.tasks.map((row) => (row.id === 'raw' ? { ...row, timeSpentMinutes: -5 } : row)) });
        await useTaskStore.getState().fetchData({ silent: true, recoveryLoad: true });
        expect(useTaskStore.getState()._tasksById.get('raw')?.timeSpentMinutes).toBe(-5);
        const fake = createHost(adapter, winner(), sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        const service = createMobileSyncService(fake.host);
        try {
            expect((await runCycle(service)).success).toBe(true);
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
        // A later store save writes every row the store shows.
        await useTaskStore.getState().updateSettings({ theme: 'dark' });
        await flushPendingSave();
        const saved = (await adapter.getData()).tasks.find((row) => row.id === 'raw');
        expect(saved?.timeSpentMinutes).toBeUndefined();
        expect(useTaskStore.getState()._tasksById.get('raw')?.timeSpentMinutes).toBeUndefined();
    });

    // A task done long ago, which the load's auto-archive migration archives, written as an old client would (no
    // pushCount, a legacy status casing), so it also needs normalizeTaskForLoad.
    const doneLongAgo = () => ({
        ...task({ id: 'done-old', title: 'Done long ago', rev: 1, revBy: 'other-device' }),
        status: 'done', completedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), pushCount: undefined,
    } as Task);
    const cycleStore = async (sliced: boolean, remote: AppData) => {
        const adapter = await openStore(true, false, [other]);
        const fake = createHost(adapter, remote, sliced);
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        const load = vi.spyOn(useTaskStore.getState(), 'fetchData');
        load.mockClear();
        const service = createMobileSyncService(fake.host);
        try {
            expect((await runCycle(service)).success).toBe(true);
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
        const refreshes = load.mock.calls.filter(([options]) => options?.preloadedData).length;
        load.mockRestore();
        const state = useTaskStore.getState();
        // Each fresh store draws its own analytics id; the sync status times are the cycle's own.
        const { lastSyncAt: _at, lastSyncHistory: _history, lastSyncStats: _stats, analyticsProfileId: _id, ...settings } = state.settings;
        return {
            refreshes,
            store: { tasks: state._allTasks, visible: state.tasks, projects: state._allProjects, settings },
        };
    };

    it.each([
        ['a document no load would change', () => winner()],
        ['a document that needs normalizeTaskForLoad and a load migration', () => ({ ...winner(), tasks: [...winner().tasks, doneLongAgo()] })],
    ])('ends with the store an unsliced cycle leaves, refreshing only when the load changes something: %s', async (name, remote) => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
        try {
            const unsliced = await cycleStore(false, remote());
            const sliced = await cycleStore(true, remote());
            expect(unsliced.refreshes).toBe(1);
            expect(sliced.refreshes).toBe(name.startsWith('a document no load') ? 0 : 1);
            expect(sliced.store).toEqual(unsliced.store);
            if (!name.startsWith('a document no load')) {
                expect(sliced.store.tasks.find((row) => row.id === 'done-old')?.status).toBe('archived');
            }
        } finally {
            vi.useRealTimers();
        }
    });
});
