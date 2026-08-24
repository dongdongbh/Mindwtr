import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushPendingSave,
    runDataTransferTransactionWithoutSnapshot,
    setStorageAdapter,
    useTaskStore,
} from '@mindwtr/core';
import type { AppData, StorageAdapter } from '@mindwtr/core';
import {
    __localDataWatcherTestUtils,
    createLocalDataWatcherController,
    markLocalSqliteWrite,
    markLocalWrite,
    start,
    stop,
} from './local-data-watcher';

function getTauriMocks() {
    const globalObject = globalThis as typeof globalThis & {
        __localWatcherInvokeMock?: ReturnType<typeof vi.fn>;
    };
    if (!globalObject.__localWatcherInvokeMock) {
        globalObject.__localWatcherInvokeMock = vi.fn();
    }
    return {
        invokeMock: globalObject.__localWatcherInvokeMock,
    };
}

vi.mock('@tauri-apps/api/core', async () => {
    return {
        SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
        Channel: class {},
        PluginListener: class {
            async unregister() {
                return undefined;
            }
        },
        Resource: class {},
        addPluginListener: async () => ({
            unregister: async () => undefined,
        }),
        checkPermissions: async () => undefined,
        convertFileSrc: (filePath: string) => filePath,
        invoke: getTauriMocks().invokeMock,
        isTauri: () => true,
        requestPermissions: async () => undefined,
        transformCallback: () => 1,
    };
});

let nowMs = 0;
let externalData: AppData;
let saveCalls: AppData[] = [];
let timerId = 1;
const scheduledTimers = new Map<number, () => void>();

const scheduleMock = ((callback: TimerHandler) => {
    const id = timerId++;
    const fn = typeof callback === 'function' ? callback : () => undefined;
    scheduledTimers.set(id, fn as () => void);
    return id as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

const cancelScheduleMock = ((id: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(id as unknown as number);
}) as unknown as typeof clearTimeout;

const flushScheduledTimers = async () => {
    let guard = 0;
    let idleRounds = 0;
    while (guard < 50 && idleRounds < 5) {
        guard += 1;
        if (scheduledTimers.size === 0) {
            idleRounds += 1;
            await Promise.resolve();
            continue;
        }
        idleRounds = 0;
        const callbacks = Array.from(scheduledTimers.entries());
        scheduledTimers.clear();
        callbacks.forEach(([, callback]) => callback());
        await Promise.resolve();
    }
    await __localDataWatcherTestUtils.waitForPendingMergeForTests();
};

// Like flushScheduledTimers, but yields a few extra microtask ticks per round.
// A single retry cycle (reject → catch → reschedule → registration cleanup)
// is several hops; this fake zero-delay scheduler can fire the NEXT queued
// retry timer before that chain settles, finding the previous attempt's
// re-entrancy guard (channel.registration) still set and silently no-op'ing
// instead of retrying. Only tests that chain multiple retries need this.
const flushScheduledTimersSlowly = async () => {
    let guard = 0;
    let idleRounds = 0;
    while (guard < 50 && idleRounds < 5) {
        guard += 1;
        if (scheduledTimers.size === 0) {
            idleRounds += 1;
            await Promise.resolve();
            continue;
        }
        idleRounds = 0;
        const callbacks = Array.from(scheduledTimers.entries());
        scheduledTimers.clear();
        callbacks.forEach(([, callback]) => callback());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }
    await __localDataWatcherTestUtils.waitForPendingMergeForTests();
};

const flushNextSqliteTimer = async () => {
    await vi.waitFor(() => expect(scheduledTimers.size).toBeGreaterThan(0));
    const nextTimer = scheduledTimers.entries().next().value;
    if (!nextTimer) throw new Error('Expected a scheduled SQLite timer');
    const [id, callback] = nextTimer;
    scheduledTimers.delete(id);
    callback();
    await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();
};

const emptyData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: { deviceId: 'dev-local' },
});

const storageAdapter: StorageAdapter = {
    getData: async () => emptyData(),
    saveData: async (data) => {
        saveCalls.push(data);
    },
    queryTasks: async () => [],
    searchAll: async () => ({ tasks: [], projects: [] }),
};

beforeEach(() => {
    const { invokeMock } = getTauriMocks();
    invokeMock.mockReset();
    (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};

    nowMs = 0;
    timerId = 1;
    scheduledTimers.clear();
    saveCalls = [];
    externalData = emptyData();

    setStorageAdapter(storageAdapter);

    useTaskStore.setState((state) => ({
        ...state,
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        _allTasks: [],
        _allProjects: [],
        _allSections: [],
        _allAreas: [],
        _allPeople: [],
        _peopleById: new Map(),
        settings: { deviceId: 'dev-local' },
        editLockCount: 0,
        lastDataChangeAt: 0,
        error: null,
    }));

    __localDataWatcherTestUtils.resetForTests();
    __localDataWatcherTestUtils.setDependenciesForTests({
        now: () => nowMs,
        readDataJson: async () => externalData,
        // Legacy refresh tests exercise the refresh lane itself; the no-op
        // probe fails open so they keep their original semantics. The probe's
        // own behavior has dedicated tests below.
        readStorageSnapshot: async () => {
            throw new Error('storage snapshot probe unavailable');
        },
        schedule: scheduleMock,
        cancelSchedule: cancelScheduleMock,
        hashPayload: async (payload) => payload,
        logInfo: () => undefined,
        logWarn: () => undefined,
    });
});

afterEach(async () => {
    __localDataWatcherTestUtils.resetForTests();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    scheduledTimers.clear();
    await flushPendingSave();
});

describe('local-data-watcher', () => {
    it('retries only the watcher channel whose registration failed', async () => {
        const dataUnwatch = vi.fn();
        const sqliteUnwatch = vi.fn();
        const watchFile = vi
            .fn()
            .mockResolvedValueOnce(dataUnwatch)
            .mockRejectedValueOnce(new Error('SQLite watch unavailable'))
            .mockResolvedValueOnce(sqliteUnwatch);
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        expect(watchFile.mock.calls.map(([path]) => path)).toEqual(['/tmp/mindwtr/data.json', '/tmp/mindwtr']);

        await flushScheduledTimers();

        expect(watchFile.mock.calls.map(([path]) => path)).toEqual([
            '/tmp/mindwtr/data.json',
            '/tmp/mindwtr',
            '/tmp/mindwtr',
        ]);
        controller.stop();
        expect(dataUnwatch).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
    });

    it('keeps the SQLite watcher while retrying a failed data watcher', async () => {
        const dataUnwatch = vi.fn();
        const sqliteUnwatch = vi.fn();
        let dataAttempts = 0;
        const watchFile = vi.fn(async (path: string) => {
            if (path.endsWith('data.json')) {
                dataAttempts += 1;
                if (dataAttempts === 1) throw new Error('Data watch unavailable');
                return dataUnwatch;
            }
            return sqliteUnwatch;
        });
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        await flushScheduledTimers();

        expect(watchFile.mock.calls.map(([path]) => path)).toEqual([
            '/tmp/mindwtr/data.json',
            '/tmp/mindwtr',
            '/tmp/mindwtr/data.json',
        ]);
        controller.stop();
        expect(dataUnwatch).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
    });

    it('warns on watch registration exhaustion and re-arms from refreshFromDiskNow (#S6)', async () => {
        const dataUnwatch = vi.fn();
        let attempts = 0;
        const watchFile = vi.fn(async () => {
            attempts += 1;
            if (attempts <= 3) throw new Error('mount unresponsive');
            return dataUnwatch;
        });
        const logWarn = vi.fn();
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            readDataJson: async () => emptyData(),
            logInfo: () => undefined,
            logWarn,
        });

        await controller.start('/tmp/mindwtr/data.json');
        await flushScheduledTimersSlowly(); // retry #1
        await flushScheduledTimersSlowly(); // retry #2 — exhausts the budget

        expect(attempts).toBe(3);
        expect(logWarn).toHaveBeenCalledWith(
            expect.stringContaining('exhausted'),
            expect.anything(),
        );

        // Exhausted: the channel is now blind, nothing left scheduled on its own.
        logWarn.mockClear();
        await flushScheduledTimers();
        expect(attempts).toBe(3);

        // The coarse trigger re-arms it without a new timer kind.
        await controller.refreshFromDiskNow();
        expect(attempts).toBe(4);

        controller.stop();
    });

    it('rearmExhaustedWatchers is a no-op for a healthy channel and retries an exhausted one (#S6)', async () => {
        const healthyUnwatch = vi.fn();
        let healthyAttempts = 0;
        const healthyController = createLocalDataWatcherController({
            watchFile: vi.fn(async () => {
                healthyAttempts += 1;
                return healthyUnwatch;
            }),
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });
        await healthyController.start('/tmp/mindwtr/data.json');
        expect(healthyAttempts).toBe(1);

        healthyController.rearmExhaustedWatchers();
        expect(healthyAttempts).toBe(1); // O(1) no-op: nothing exhausted

        healthyController.stop();

        let attempts = 0;
        const controller = createLocalDataWatcherController({
            watchFile: vi.fn(async () => {
                attempts += 1;
                throw new Error('mount unresponsive');
            }),
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });
        await controller.start('/tmp/mindwtr/data.json');
        await flushScheduledTimersSlowly();
        await flushScheduledTimersSlowly();
        expect(attempts).toBe(3); // exhausted

        controller.rearmExhaustedWatchers();
        expect(attempts).toBe(4); // one fresh attempt

        controller.stop();
    });

    it('unwatches a registration that resolves after stop', async () => {
        let resolveRegistration: ((unwatch: () => void) => void) | undefined;
        const lateUnwatch = vi.fn();
        const watchFile = vi.fn(
            () =>
                new Promise<() => void>((resolve) => {
                    resolveRegistration = resolve;
                }),
        );
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        const starting = controller.start('/tmp/mindwtr/data.json');
        controller.stop();
        resolveRegistration?.(lateUnwatch);
        await starting;

        expect(lateUnwatch).toHaveBeenCalledTimes(1);
    });

    it('contains throwing cleanup callbacks and still disposes every watcher resource', async () => {
        const dataUnwatch = vi.fn(() => {
            throw new Error('data unwatch failed');
        });
        const sqliteUnwatch = vi.fn();
        const editUnlockUnsubscribe = vi.fn(() => {
            throw new Error('edit unlock unsubscribe failed');
        });
        const callbacks: Array<(event: { path?: string; paths?: string[] }) => void> = [];
        const watchFile = vi.fn(async (_path: string, callback: (event: { path?: string; paths?: string[] }) => void) => {
            callbacks.push(callback);
            return callbacks.length === 1 ? dataUnwatch : sqliteUnwatch;
        });
        const controller = createLocalDataWatcherController({
            watchFile,
            getEditLockCount: () => 1,
            subscribeStore: () => editUnlockUnsubscribe,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        callbacks[1]?.({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });

        expect(() => controller.stop()).not.toThrow();
        expect(dataUnwatch).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
        expect(editUnlockUnsubscribe).toHaveBeenCalledTimes(1);
        expect(() => controller.stop()).not.toThrow();
        expect(dataUnwatch).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
        expect(editUnlockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('ignores stale watcher callbacks after a failed unwatch and restart', async () => {
        const callbacks: Array<(event: { path?: string; paths?: string[] }) => void> = [];
        const watchFile = vi.fn(async (_path: string, callback: (event: { path?: string; paths?: string[] }) => void) => {
            callbacks.push(callback);
            return () => {
                throw new Error('unwatch failed');
            };
        });
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            // start() now ends with one immediate merge check (#S11); give it
            // a real read so it resolves as a clean no-op instead of hitting
            // the unconfigured default Tauri invoke.
            readDataJson: async () => emptyData(),
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        const staleSqliteCallback = callbacks[1];
        controller.stop();

        staleSqliteCallback?.({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        expect(scheduledTimers.size).toBe(0);

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        staleSqliteCallback?.({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        expect(scheduledTimers.size).toBe(0);

        callbacks[3]?.({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        expect(scheduledTimers.size).toBe(1);
        controller.stop();
    });

    it('abandons an external merge when its watcher generation stops during the disk read', async () => {
        const incomingTask = {
            id: 'stale-generation-data',
            title: 'Must not persist after stop',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
        };
        let releaseRead: ((data: AppData) => void) | undefined;
        let markReadStarted: (() => void) | undefined;
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        const persistMergedData = vi.fn();
        const controller = createLocalDataWatcherController({
            readDataJson: () =>
                new Promise<AppData>((resolve) => {
                    releaseRead = resolve;
                    markReadStarted?.();
                }),
            persistMergedData,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            hashPayload: async (payload) => payload,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        const refresh = controller.testUtils.triggerChangeForTests();
        await readStarted;
        controller.stop();
        releaseRead?.({ ...emptyData(), tasks: [incomingTask] });
        await refresh;

        expect(persistMergedData).not.toHaveBeenCalled();
    });

    it('does not reconcile a persisted external merge after its watcher generation stops', async () => {
        const incomingTask = {
            id: 'stale-generation-persist',
            title: 'Must not replace newer store state after stop',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
        };
        const newerTask = {
            ...incomingTask,
            id: 'newer-local-state',
            title: 'Created after watcher stop',
        };
        let releaseSave: (() => void) | undefined;
        let markSaveStarted: (() => void) | undefined;
        const saveGate = new Promise<void>((resolve) => {
            releaseSave = resolve;
        });
        const saveStarted = new Promise<void>((resolve) => {
            markSaveStarted = resolve;
        });
        setStorageAdapter({
            ...storageAdapter,
            saveData: async (data) => {
                markSaveStarted?.();
                await saveGate;
                return data;
            },
        });
        const controller = createLocalDataWatcherController({
            readDataJson: async () => ({ ...emptyData(), tasks: [incomingTask] }),
            getSnapshot: () => emptyData(),
            merge: (_local, incoming) => incoming,
            normalize: (data) => data,
            hashPayload: async (payload) => payload,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        const refresh = controller.testUtils.triggerChangeForTests();
        await saveStarted;
        controller.stop();
        useTaskStore.setState({
            tasks: [newerTask],
            _allTasks: [newerTask],
            lastDataChangeAt: 1,
        });
        releaseSave?.();
        await refresh;

        expect(useTaskStore.getState()._allTasks.map((task) => task.id)).toEqual(['newer-local-state']);
    });

    it('does not apply an in-flight SQLite snapshot after its watcher generation stops', async () => {
        const incomingTask = {
            id: 'stale-generation-sqlite',
            title: 'Must not enter the store after stop',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
        };
        let releaseRead: ((data: AppData) => void) | undefined;
        let markReadStarted: (() => void) | undefined;
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        setStorageAdapter({
            ...storageAdapter,
            getData: () =>
                new Promise<AppData>((resolve) => {
                    releaseRead = resolve;
                    markReadStarted?.();
                }),
        });
        const controller = createLocalDataWatcherController({
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
            hashPayload: async (payload) => payload,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        const refresh = controller.testUtils.triggerSqliteChangeForTests();
        await readStarted;
        controller.stop();
        releaseRead?.({ ...emptyData(), tasks: [incomingTask] });
        await refresh;

        expect(useTaskStore.getState()._allTasks).toEqual([]);
    });

    it('contains throwing timer cancellation and still disposes every watcher resource', async () => {
        const sqliteUnwatch = vi.fn();
        const watchFile = vi.fn(async (path: string) => {
            if (path.endsWith('data.json')) throw new Error('Data watch unavailable');
            return sqliteUnwatch;
        });
        const cancelSchedule = vi.fn(() => {
            throw new Error('timer cancellation failed');
        }) as unknown as typeof clearTimeout;
        const controller = createLocalDataWatcherController({
            watchFile,
            schedule: scheduleMock,
            cancelSchedule,
            // start() now ends with one immediate merge check (#S11); give it
            // a real read so it resolves as a clean no-op instead of hitting
            // the unconfigured default Tauri invoke.
            readDataJson: async () => emptyData(),
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        await controller.start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        expect(() => controller.stop()).not.toThrow();
        expect(cancelSchedule).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
        expect(() => controller.stop()).not.toThrow();
        expect(cancelSchedule).toHaveBeenCalledTimes(1);
        expect(sqliteUnwatch).toHaveBeenCalledTimes(1);
    });

    it('keeps controller payload and timer state isolated', () => {
        const controllerA = createLocalDataWatcherController({
            now: () => 100,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
        });
        const controllerB = createLocalDataWatcherController({
            now: () => 200,
            schedule: scheduleMock,
            cancelSchedule: cancelScheduleMock,
        });
        const payloadA = {
            ...emptyData(),
            tasks: [
                {
                    id: 'controller-a',
                    title: 'Controller A',
                    status: 'next' as const,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-08-09T00:00:00.000Z',
                    updatedAt: '2026-08-09T00:00:00.000Z',
                },
            ],
        };

        controllerA.markLocalWrite(payloadA);

        expect(controllerA.testUtils.getPendingSelfWritePayloadLengthForTests()).toBeGreaterThan(0);
        expect(controllerB.testUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
        controllerA.stop();
        expect(scheduledTimers.size).toBe(0);
    });

    it('retries a transient failure from the production storage adapter', async () => {
        const getData = vi.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(emptyData());
        setStorageAdapter({ ...storageAdapter, getData });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();
        expect(getData).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().error).toContain('database is locked');

        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(getData).toHaveBeenCalledTimes(2);
        expect(useTaskStore.getState().error).toBeNull();
    });

    it('retries a transient SQLite refresh failure on a bounded delayed lane', async () => {
        const refreshStorageData = vi
            .fn()
            .mockRejectedValueOnce(new Error('database is locked'))
            .mockResolvedValue(undefined);
        __localDataWatcherTestUtils.setDependenciesForTests({ refreshStorageData });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();
        expect(refreshStorageData).toHaveBeenCalledTimes(1);

        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();
        expect(refreshStorageData).toHaveBeenCalledTimes(2);
    });

    it('resets an exhausted SQLite retry budget when a fresh WAL event arrives', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const refreshStorageData = vi.fn().mockRejectedValue(new Error('database is busy'));
        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();
        await flushNextSqliteTimer();
        await flushNextSqliteTimer();
        expect(refreshStorageData).toHaveBeenCalledTimes(3);

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushNextSqliteTimer();
        await flushNextSqliteTimer();
        await flushNextSqliteTimer();

        expect(refreshStorageData).toHaveBeenCalledTimes(6);
    });

    it('cancels a delayed SQLite refresh retry during watcher shutdown', async () => {
        const refreshStorageData = vi.fn().mockRejectedValue(new Error('database is busy'));
        __localDataWatcherTestUtils.setDependenciesForTests({ refreshStorageData });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();
        expect(refreshStorageData).toHaveBeenCalledTimes(1);

        __localDataWatcherTestUtils.resetForTests();
        await flushScheduledTimers();
        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('refreshes the store when SQLite WAL files change', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const task = {
            id: 'mcp-1',
            title: 'From MCP',
            status: 'inbox' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        const refreshStorageData = vi.fn(async () => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [task],
                _allTasks: [task],
                lastDataChangeAt: 1,
            }));
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        expect(watchers.map((watcher) => watcher.path)).toEqual(['/tmp/mindwtr/data.json', '/tmp/mindwtr']);

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().tasks[0]?.id).toBe('mcp-1');
    });

    it('monotonically stamps a changed SQLite refresh but leaves no-op refreshes unchanged', async () => {
        const changedTask = {
            id: 'sqlite-stamp',
            title: 'SQLite stamp',
            status: 'inbox' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        useTaskStore.setState({ lastDataChangeAt: 40 });
        const refreshStorageData = vi.fn(async () => {
            if (refreshStorageData.mock.calls.length === 1) {
                useTaskStore.setState({ _allTasks: [changedTask] });
            }
        });
        __localDataWatcherTestUtils.setDependenciesForTests({ refreshStorageData });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();

        expect(useTaskStore.getState().lastDataChangeAt).toBe(41);

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();

        expect(useTaskStore.getState().lastDataChangeAt).toBe(41);
    });

    it('skips the store refresh entirely when the SQLite snapshot matches the in-memory data', async () => {
        const refreshStorageData = vi.fn(async () => undefined);
        const logInfo = vi.fn();
        __localDataWatcherTestUtils.setDependenciesForTests({
            refreshStorageData,
            readStorageSnapshot: async () => emptyData(),
            logInfo,
        });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();

        expect(refreshStorageData).not.toHaveBeenCalled();
        expect(
            logInfo.mock.calls.some(([message]) =>
                String(message).includes('SQLite refresh no data changes'),
            ),
        ).toBe(true);
    });

    it('still refreshes when the SQLite snapshot differs from the in-memory data', async () => {
        const changedTask = {
            id: 'probe-diff',
            title: 'Probe diff',
            status: 'inbox' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        const refreshStorageData = vi.fn(async () => undefined);
        __localDataWatcherTestUtils.setDependenciesForTests({
            refreshStorageData,
            readStorageSnapshot: async () => ({ ...emptyData(), tasks: [changedTask] }),
        });

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('keeps an editor-blocked SQLite refresh pending until editing unlocks', async () => {
        const refreshStorageData = vi.fn(async () => undefined);
        __localDataWatcherTestUtils.setDependenciesForTests({ refreshStorageData });
        useTaskStore.getState().lockEditing();

        await __localDataWatcherTestUtils.triggerSqliteChangeForTests();
        const callsWhileEditing = refreshStorageData.mock.calls.length;

        useTaskStore.getState().unlockEditing();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(callsWhileEditing).toBe(0);
        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('waits for an active document write before refreshing a SQLite WAL change', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const events: string[] = [];
        let releaseDocumentWrite: (() => void) | undefined;
        let markDocumentWriteStarted: (() => void) | undefined;
        let markRefreshComplete: (() => void) | undefined;
        const documentWriteGate = new Promise<void>((resolve) => {
            releaseDocumentWrite = resolve;
        });
        const documentWriteStarted = new Promise<void>((resolve) => {
            markDocumentWriteStarted = resolve;
        });
        const refreshComplete = new Promise<void>((resolve) => {
            markRefreshComplete = resolve;
        });
        const refreshStorageData = vi.fn(async () => {
            events.push('sqlite:refresh');
            markRefreshComplete?.();
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        const documentWrite = runDataTransferTransactionWithoutSnapshot({
            operation: 'test concurrent document write',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => 0,
            readCurrentData: async () => emptyData(),
            apply: (data) => ({ data, result: undefined }),
            persistData: async () => {
                events.push('document:start');
                markDocumentWriteStarted?.();
                await documentWriteGate;
                events.push('document:end');
            },
            refreshData: async () => undefined,
        });

        await documentWriteStarted;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });

        try {
            await flushScheduledTimers();

            expect(refreshStorageData).not.toHaveBeenCalled();
            expect(events).toEqual(['document:start']);

            releaseDocumentWrite?.();
            await documentWrite;
            await refreshComplete;

            expect(events).toEqual(['document:start', 'document:end', 'sqlite:refresh']);
        } finally {
            releaseDocumentWrite?.();
            await Promise.allSettled([documentWrite, refreshComplete]);
        }
    });

    it('ignores SQLite shared-memory events from read activity', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-shm'] });
        await flushScheduledTimers();

        expect(refreshStorageData).not.toHaveBeenCalled();

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('defers SQLite events during a local-write window and refreshes once after it drains', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        markLocalSqliteWrite();
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        expect(refreshStorageData).not.toHaveBeenCalled();

        nowMs = 2100;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        expect(refreshStorageData).not.toHaveBeenCalled();

        nowMs = 15100;
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
        await flushScheduledTimers();
        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('drains a real WAL event that arrives during SQLite no-op suppression', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(2);

        nowMs = 2100;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(3);
    });

    it('drains an external WAL event that arrives during an in-flight no-op refresh', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const externalTask = {
            id: 'external-during-refresh',
            title: 'Written while refresh was in flight',
            status: 'inbox' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        let diskTasks: AppData['tasks'] = [];
        let releaseFirstRefresh: (() => void) | undefined;
        let markFirstRefreshStarted: (() => void) | undefined;
        const firstRefreshGate = new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve;
        });
        const firstRefreshStarted = new Promise<void>((resolve) => {
            markFirstRefreshStarted = resolve;
        });
        const refreshStorageData = vi.fn(async () => {
            const loadedTasks = diskTasks.slice();
            if (refreshStorageData.mock.calls.length === 1) {
                markFirstRefreshStarted?.();
                await firstRefreshGate;
            }
            useTaskStore.setState({ tasks: loadedTasks, _allTasks: loadedTasks });
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();
        await firstRefreshStarted;

        diskTasks = [externalTask];
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });

        releaseFirstRefresh?.();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();
        await flushScheduledTimers();
        await __localDataWatcherTestUtils.waitForPendingSqliteRefreshForTests();

        expect(refreshStorageData).toHaveBeenCalledTimes(2);
        expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual(['external-during-refresh']);
    });

    it('does not treat sync bookkeeping-only SQLite refreshes as app data changes', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const logInfo = vi.fn();
        const refreshStorageData = vi.fn(async () => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-01-01T00:00:00.000Z',
                    lastSyncStatus: 'success',
                },
                lastDataChangeAt: 1,
            }));
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
            logInfo,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        logInfo.mockClear();

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
        expect(logInfo).not.toHaveBeenCalledWith('[local-data-watcher] Refreshed after SQLite change');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('does not cancel a pending external SQLite refresh when a local SQLite write follows', async () => {
        const watchers: Array<{
            path: string;
            callback: (event: { path?: string; paths?: string[] }) => void;
        }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        markLocalSqliteWrite();
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('ignores self-written payloads after the ignore window drains', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-1',
                    title: 'Written by sync',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite(externalData);

        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2200;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
    });

    it('ignores older self-written payloads when multiple local writes happen back-to-back', async () => {
        const firstWrite = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-older',
                    title: 'First write',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;
        const secondWrite = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-newer',
                    title: 'Second write',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite(firstWrite);

        nowMs = 500;
        markLocalWrite(secondWrite);

        externalData = firstWrite;
        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2600;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBeGreaterThan(0);

        externalData = secondWrite;
        await __localDataWatcherTestUtils.triggerChangeForTests();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
    });

    it('re-reads external writes that happen during ignore window', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'ext-1',
                    title: 'From CLI',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite();

        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2200;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'ext-1')).toBe(true);
    });

    it('observes an external change still pending at stop() once start() runs again (#S11)', async () => {
        let capturedCallback: ((event: { path?: string; paths?: string[] }) => void) | undefined;
        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (_path, callback) => {
                capturedCallback = callback;
                return () => undefined;
            },
        });

        // Nothing was dropped by a prior stop(), so this first start() does
        // not run its trailing immediate check (#S11/C2).
        await start('/tmp/mindwtr/data.json');

        // A write lands while the watcher is up: debounced, not yet merged.
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'ext-1',
                    title: 'From CLI',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;
        capturedCallback?.({ path: '/tmp/mindwtr/data.json' });
        expect(saveCalls).toHaveLength(0);

        // stop() today drops pendingExternalChange and cancels the debounce
        // timer (StrictMode/HMR/teardown can hit this window) — the change
        // is now unobserved unless data.json changes again.
        stop();

        // start() must observe it without needing a fresh filesystem event.
        await start('/tmp/mindwtr/data.json');

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'ext-1')).toBe(true);
    });

    it('runs no merge on an ordinary first start() with nothing dropped by a prior stop() (C2)', async () => {
        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async () => () => undefined,
        });

        // Disk differs from the (still unhydrated) local store — if start()
        // ran its trailing check unconditionally here, it would find a
        // difference and persist a full-document save with no CAS baseline,
        // stomping whatever fetchData is about to load.
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'launch-race',
                    title: 'Should not merge on launch',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        await start('/tmp/mindwtr/data.json');

        expect(saveCalls).toHaveLength(0);
    });

    it('can merge an explicit cross-window refresh without waiting for the watcher debounce', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'quick-add-1',
                    title: 'From quick add window',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite();

        nowMs = 1000;
        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'quick-add-1')).toBe(true);
        expect(scheduledTimers.size).toBe(0);
    });

    it('waits for a full-document transfer before reading and merging an external snapshot', async () => {
        const transferTask = {
            id: 'transfer-1',
            title: 'Restored during transfer',
            status: 'next' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        const externalTask = {
            id: 'external-1',
            title: 'Written by another process',
            status: 'inbox' as const,
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        } as AppData['tasks'][number];
        const transferData = { ...emptyData(), tasks: [transferTask] } as AppData;
        const externalSnapshot = {
            ...emptyData(),
            tasks: [externalTask],
        } as AppData;
        let currentData = emptyData();
        let releaseRefresh: (() => void) | undefined;
        let markRefreshStarted: (() => void) | undefined;
        const refreshGate = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        const refreshStarted = new Promise<void>((resolve) => {
            markRefreshStarted = resolve;
        });
        const readDataJson = vi.fn(async () => externalSnapshot);

        __localDataWatcherTestUtils.setDependenciesForTests({
            readDataJson,
            getSnapshot: () => currentData,
            merge: (local, incoming) => ({
                ...local,
                tasks: [...local.tasks, ...incoming.tasks],
            }),
            persistMergedData: async (merged) => {
                currentData = merged;
            },
        });

        const transfer = runDataTransferTransactionWithoutSnapshot({
            operation: 'test restore',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => 0,
            readCurrentData: async () => currentData,
            apply: () => ({ data: transferData, result: undefined }),
            persistData: async (data) => {
                currentData = data;
            },
            refreshData: async () => {
                markRefreshStarted?.();
                await refreshGate;
                currentData = transferData;
            },
        });

        await refreshStarted;
        const watcherRefresh = __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(readDataJson).not.toHaveBeenCalled();

        releaseRefresh?.();
        await Promise.all([transfer, watcherRefresh]);

        expect(readDataJson).toHaveBeenCalledTimes(1);
        expect(currentData.tasks.map((task) => task.id)).toEqual(['transfer-1', 'external-1']);
    });

    it('persists merged changes through store save queue (without direct tauri save_data calls)', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'ext-2',
                    title: 'Merged task',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        const { invokeMock } = getTauriMocks();
        expect(invokeMock.mock.calls.some(([command]) => command === 'save_data')).toBe(false);
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'ext-2')).toBe(true);
    });

    it('reconciles the store to the canonical native snapshot before ordinary writes resume', async () => {
        const externalTask = {
            id: 'external-race',
            title: 'External task',
            status: 'next' as const,
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        } as AppData['tasks'][number];
        const canonicalOnlyTask = {
            id: 'canonical-race',
            title: 'Concurrent native task',
            status: 'next' as const,
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z',
        } as AppData['tasks'][number];
        externalData = { ...emptyData(), tasks: [externalTask] } as AppData;
        let firstSave = true;
        const attemptedSnapshots: AppData[] = [];

        setStorageAdapter({
            ...storageAdapter,
            saveData: (async (data: AppData) => {
                attemptedSnapshots.push(data);
                if (firstSave) {
                    firstSave = false;
                    return { ...data, tasks: [...data.tasks, canonicalOnlyTask] };
                }
                return data;
            }) as StorageAdapter['saveData'],
        });

        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(
            useTaskStore
                .getState()
                ._allTasks.map((task) => task.id)
                .sort(),
        ).toEqual(['canonical-race', 'external-race']);

        await useTaskStore.getState().addTask('Ordinary write after watcher');
        await flushPendingSave();

        const lastAttempt = attemptedSnapshots[attemptedSnapshots.length - 1];
        expect(lastAttempt?.tasks.some((task) => task.id === 'canonical-race')).toBe(true);
    });

    it('keeps the store durable and automatically retries a transient merged-save failure', async () => {
        const externalTask = {
            id: 'ext-retry-1',
            title: 'Persist after retry',
            status: 'next' as const,
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        } as AppData['tasks'][number];
        externalData = { ...emptyData(), tasks: [externalTask] } as AppData;
        let durableData = emptyData();
        let saveAttempts = 0;

        setStorageAdapter({
            ...storageAdapter,
            getData: async () => durableData,
            saveData: async (data) => {
                saveAttempts += 1;
                markLocalWrite(data);
                if (saveAttempts <= 2) {
                    throw new Error('transient save failure');
                }
                durableData = data;
            },
        });

        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(saveAttempts).toBe(2);
        expect(useTaskStore.getState().tasks).toEqual([]);
        expect(durableData.tasks).toEqual([]);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);

        await flushScheduledTimers();

        expect(saveAttempts).toBe(3);
        expect(durableData.tasks.map((task) => task.id)).toEqual(['ext-retry-1']);
        expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual(['ext-retry-1']);

        externalData = durableData;
        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(saveAttempts).toBe(3);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
    });

    it('does not schedule delayed retries for terminal merged-save failures', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'terminal-retry',
                    title: 'Terminal retry',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;
        let saveAttempts = 0;
        setStorageAdapter({
            ...storageAdapter,
            saveData: async () => {
                saveAttempts += 1;
                throw new Error('Refusing to overwrite existing data with an empty snapshot');
            },
        });

        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();
        await flushScheduledTimers();

        expect(saveAttempts).toBe(1);
        expect(useTaskStore.getState()._allTasks).toEqual([]);
    });

    it('cancels a delayed merged-save retry during watcher shutdown', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'shutdown-retry',
                    title: 'Shutdown retry',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;
        let saveAttempts = 0;
        setStorageAdapter({
            ...storageAdapter,
            saveData: async () => {
                saveAttempts += 1;
                throw new Error('transient save failure');
            },
        });

        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();
        expect(saveAttempts).toBe(2);

        __localDataWatcherTestUtils.resetForTests();
        await flushScheduledTimers();

        expect(saveAttempts).toBe(2);
    });

    it('preserves merged people when writing external data through the store', async () => {
        useTaskStore.setState({ lastDataChangeAt: 9_000_000_000_000_000 });
        externalData = {
            ...emptyData(),
            people: [
                {
                    id: 'person-1',
                    name: 'Alex',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        };

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.people?.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState().people.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState()._allPeople.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState()._peopleById.get('person-1')?.name).toBe('Alex');
        expect(useTaskStore.getState().lastDataChangeAt).toBe(9_000_000_000_000_001);
    });

    it('skips merge work when the external payload already matches the local snapshot', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'same-1',
                    title: 'Already current',
                    status: 'next',
                    createdAt: '2026-01-03T00:00:00.000Z',
                    updatedAt: '2026-01-03T00:00:00.000Z',
                },
            ],
        } as AppData;
        const mergeSpy = vi.fn((local: AppData) => local);

        __localDataWatcherTestUtils.setDependenciesForTests({
            getSnapshot: () => externalData,
            merge: mergeSpy,
        });

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        expect(mergeSpy).not.toHaveBeenCalled();
        expect(saveCalls).toHaveLength(0);
    });
});
