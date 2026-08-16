import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeStableValueFingerprint, computeSyncPayloadFingerprint, type AppData } from '@mindwtr/core';

type MockStoreState = {
    _allTasks: AppData['tasks'];
    _allProjects: AppData['projects'];
    _allSections: AppData['sections'];
    _allAreas: AppData['areas'];
    _allPeople: AppData['people'];
    lastDataChangeAt: number;
    settings: AppData['settings'];
    fetchData: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
    setError: ReturnType<typeof vi.fn>;
};

const emptyStats = {
    tasks: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
    projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
    sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
    areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
};

const entityIds = (tasks: string[] = []) => ({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    people: [],
});

const localData: AppData = {
    tasks: [
        {
            id: 'task-1',
            title: 'Task',
            status: 'inbox',
            tags: [],
            contexts: [],
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        },
    ],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
};

const buildResponse = (
    status: number,
    body: string,
    headers: Record<string, string> = {}
): Response => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
    } as Headers,
    text: async () => body,
    json: async () => {
        try {
            return JSON.parse(body);
        } catch {
            return {};
        }
    },
} as unknown as Response);

const invokeMock = vi.hoisted(() => vi.fn());
const markLocalWriteMock = vi.hoisted(() => vi.fn());
const markLocalSqliteWriteMock = vi.hoisted(() => vi.fn());
const flushPendingSaveMock = vi.hoisted(() => vi.fn());
const performSyncCycleMock = vi.hoisted(() => vi.fn());
const getInMemoryAppDataSnapshotMock = vi.hoisted(() => vi.fn());
const applySyncedDataToStoreMock = vi.hoisted(() => vi.fn());
const useTaskStoreGetStateMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const logSyncErrorMock = vi.hoisted(() => vi.fn());
const ensureCloudKitReadyMock = vi.hoisted(() => vi.fn());
const readRemoteCloudKitMock = vi.hoisted(() => vi.fn());
const writeRemoteCloudKitMock = vi.hoisted(() => vi.fn());
const externalCalendarGetMock = vi.hoisted(() => vi.fn());
const externalCalendarSetMock = vi.hoisted(() => vi.fn());
const fsMocks = vi.hoisted(() => ({
    BaseDirectory: { Data: 'data' },
    exists: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeTextFile: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    readDir: vi.fn(),
}));
// The sync folder's exists/mkdir/remove/rename go through async Rust commands,
// not the fs plugin's main-thread ones (#1037).
const syncFsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
}));
const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(),
    join: vi.fn(),
}));
const storeStateRef = vi.hoisted(() => ({
    current: {
        _allTasks: [],
        _allProjects: [],
        _allSections: [],
        _allAreas: [],
        _allPeople: [],
        lastDataChangeAt: 1,
        settings: {},
        fetchData: vi.fn(),
        updateSettings: vi.fn(),
        setError: vi.fn(),
    } as MockStoreState,
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);

vi.mock('./sync-fs', () => syncFsMocks);

vi.mock('@tauri-apps/api/path', () => pathMocks);

const syncServiceModulePromise = import('./sync-service');

describe('desktop sync-service runtime', () => {
    beforeEach(async () => {
        const syncServiceModule = await syncServiceModulePromise;
        await syncServiceModule.SyncService.resetForTests();
        // Runtime-cycle tests exercise established native configuration. Legacy
        // renderer migration has dedicated coverage in sync-service.test.ts.
        (syncServiceModule.SyncService as any).didMigrate = true;
        vi.clearAllMocks();

        storeStateRef.current = {
            _allTasks: structuredClone(localData.tasks),
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            lastDataChangeAt: 1,
            settings: {},
            fetchData: vi.fn().mockResolvedValue(undefined),
            updateSettings: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
        };

        useTaskStoreGetStateMock.mockImplementation(() => storeStateRef.current);
        flushPendingSaveMock.mockResolvedValue(undefined);
        getInMemoryAppDataSnapshotMock.mockImplementation(() => ({
            tasks: structuredClone(storeStateRef.current._allTasks),
            projects: structuredClone(storeStateRef.current._allProjects),
            sections: structuredClone(storeStateRef.current._allSections),
            areas: structuredClone(storeStateRef.current._allAreas),
            people: structuredClone(storeStateRef.current._allPeople),
            settings: structuredClone(storeStateRef.current.settings),
        }));
        applySyncedDataToStoreMock.mockImplementation((data: AppData) => {
            storeStateRef.current = {
                ...storeStateRef.current,
                _allTasks: structuredClone(data.tasks),
                _allProjects: structuredClone(data.projects),
                _allSections: structuredClone(data.sections),
                _allAreas: structuredClone(data.areas),
                _allPeople: structuredClone(data.people ?? []),
                settings: structuredClone(data.settings),
            };
        });
        externalCalendarGetMock.mockResolvedValue([]);
        externalCalendarSetMock.mockResolvedValue(undefined);
        logSyncErrorMock.mockResolvedValue(null);
        ensureCloudKitReadyMock.mockResolvedValue(undefined);
        readRemoteCloudKitMock.mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        });
        writeRemoteCloudKitMock.mockResolvedValue(undefined);

        fsMocks.exists.mockImplementation(async (path: string) => path === '/local/doc.txt');
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
        fsMocks.writeFile.mockResolvedValue(undefined);
        fsMocks.writeTextFile.mockResolvedValue(undefined);
        fsMocks.rename.mockResolvedValue(undefined);
        fsMocks.remove.mockResolvedValue(undefined);
        fsMocks.readDir.mockResolvedValue([]);
        syncFsMocks.exists.mockImplementation(async (path: string) => path === '/local/doc.txt');
        syncFsMocks.mkdir.mockResolvedValue(undefined);
        syncFsMocks.rename.mockResolvedValue(undefined);
        syncFsMocks.remove.mockResolvedValue(undefined);
        pathMocks.dataDir.mockResolvedValue('/data');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'get_sync_path') return '/sync/data.json';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });

        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            writeLocal: (data: AppData) => Promise<void>;
        }) => {
            const merged = await io.readLocal();
            storeStateRef.current = {
                ...storeStateRef.current,
                lastDataChangeAt: 2,
            };
            await io.writeLocal(merged);
            return { status: 'success', stats: emptyStats, data: merged };
        });

        syncServiceModule.__syncServiceTestUtils.resetDependenciesForTests();
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            getStoreState: useTaskStoreGetStateMock as typeof useTaskStoreGetStateMock,
            flushPendingSave: flushPendingSaveMock as typeof flushPendingSaveMock,
            performSyncCycle: performSyncCycleMock as typeof performSyncCycleMock,
            getInMemoryAppDataSnapshot: getInMemoryAppDataSnapshotMock as typeof getInMemoryAppDataSnapshotMock,
            applySyncedDataToStore: applySyncedDataToStoreMock as typeof applySyncedDataToStoreMock,
            markLocalWrite: markLocalWriteMock as typeof markLocalWriteMock,
            markLocalSqliteWrite: markLocalSqliteWriteMock as typeof markLocalSqliteWriteMock,
            reportError: vi.fn(),
            logInfo: logInfoMock as typeof logInfoMock,
            logWarn: logWarnMock as typeof logWarnMock,
            logSyncError: logSyncErrorMock as typeof logSyncErrorMock,
            sanitizeLogMessage: (value: string) => value,
            getExternalCalendars: externalCalendarGetMock as typeof externalCalendarGetMock,
            setExternalCalendars: externalCalendarSetMock as typeof externalCalendarSetMock,
            ensureCloudKitReady: ensureCloudKitReadyMock as typeof ensureCloudKitReadyMock,
            readRemoteCloudKit: readRemoteCloudKitMock as typeof readRemoteCloudKitMock,
            writeRemoteCloudKit: writeRemoteCloudKitMock as typeof writeRemoteCloudKitMock,
        });
    }, 30_000);

    it('persists pre-synced attachment metadata when local changes abort the sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(markLocalWriteMock).toHaveBeenCalledTimes(1);
        expect(markLocalSqliteWriteMock).toHaveBeenCalledTimes(2);
        expect(invokeMock).toHaveBeenCalledWith('save_data', {
            baselineEntities: {
                settings: {},
                tasks: [expect.objectContaining({
                    id: 'task-1',
                    attachments: [expect.objectContaining({ id: 'att-1' })],
                })],
                observedEntityIds: entityIds(['task-1']),
            },
            data: expect.objectContaining({
                tasks: [
                    expect.objectContaining({
                        id: 'task-1',
                        attachments: [
                            expect.objectContaining({
                                id: 'att-1',
                                cloudKey: 'attachments/att-1.txt',
                                localStatus: 'available',
                            }),
                        ],
                    }),
                ],
            }),
        });
    });

    it('treats pending remote write backoff as a skipped sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        performSyncCycleMock.mockResolvedValue({
            status: 'skipped',
            skipped: 'pendingRemoteWriteBackoff',
            retryInMs: 5_000,
            message: 'Sync paused briefly after remote write failure. Retry in about 5s.',
            data: localData,
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'pendingRemoteWriteBackoff', remoteWriteDeferred: true });
        expect(storeStateRef.current.setError).not.toHaveBeenCalled();
    });

    it('clears a queued follow-up when the refreshed local snapshot already matches the sync result', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const syncedAttachment = {
            ...localData.tasks[0].attachments?.[0],
            cloudKey: 'attachments/att-1.txt',
            uri: '',
            localStatus: undefined,
        } as NonNullable<AppData['tasks'][number]['attachments']>[number];
        const baseData: AppData = {
            ...structuredClone(localData),
            tasks: [{
                ...localData.tasks[0],
                attachments: [syncedAttachment],
            }],
            settings: {},
        };
        const mergedData: AppData = {
            ...structuredClone(baseData),
            tasks: [{
                ...baseData.tasks[0],
                title: 'Merged from remote',
                updatedAt: '2026-01-01T00:01:00.000Z',
            }],
        };
        const localOnlyMergedData: AppData = {
            ...structuredClone(mergedData),
            tasks: [{
                ...mergedData.tasks[0],
                attachments: [{
                    ...mergedData.tasks[0].attachments?.[0],
                    uri: '/local/doc.txt',
                    localStatus: 'available',
                } as NonNullable<AppData['tasks'][number]['attachments']>[number]],
            }],
        };
        expect(computeSyncPayloadFingerprint(localOnlyMergedData)).toBe(computeSyncPayloadFingerprint(mergedData));
        let queuedResult: Promise<unknown> | null = null;

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: structuredClone(baseData.tasks),
            settings: {},
            lastDataChangeAt: 1,
        };
        getInMemoryAppDataSnapshotMock.mockImplementation(() => ({
            tasks: structuredClone(storeStateRef.current._allTasks),
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: structuredClone(storeStateRef.current.settings),
        }));
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'get_sync_path') return '/sync/data.json';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(baseData);
            if (command === 'read_sync_file') return structuredClone(mergedData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            writeLocal: (data: AppData) => Promise<void>;
        }) => {
            await io.readLocal();
            await io.writeLocal(mergedData);
            storeStateRef.current = {
                ...storeStateRef.current,
                _allTasks: structuredClone(localOnlyMergedData.tasks),
                settings: structuredClone(localOnlyMergedData.settings),
                lastDataChangeAt: 2,
            };
            queuedResult = syncServiceModule.SyncService.performSync();
            return { status: 'success', stats: emptyStats, data: mergedData };
        });

        const result = await syncServiceModule.SyncService.performSync();
        await queuedResult;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(performSyncCycleMock).toHaveBeenCalledTimes(1);
        expect(syncServiceModule.SyncService.getSyncStatus()).toMatchObject({
            inFlight: false,
            queued: false,
            lastResult: 'success',
        });
    });

    it('clears the pending remote marker when local edits abort after remote write succeeds', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const pendingAt = '2026-01-01T00:00:00.000Z';
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'get_sync_path') return '/sync/data.json';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'save_data') return undefined;
            if (command === 'write_sync_file') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        const syncData: AppData = {
            ...structuredClone(localData),
            tasks: [{
                ...localData.tasks[0],
                attachments: [],
            }],
        };
        const editedAfterRemote: AppData = {
            ...structuredClone(syncData),
            tasks: [{
                ...syncData.tasks[0],
                title: 'Edited after remote write',
            }],
            settings: {
                pendingRemoteWriteAt: pendingAt,
            },
        };
        performSyncCycleMock.mockImplementation(async (io: {
            writeLocal: (data: AppData) => Promise<void>;
            writeRemote: (data: AppData) => Promise<void>;
            clearPendingRemoteWriteAfterLocalAbort?: (pendingAt: string) => Promise<void>;
        }) => {
            const pendingData: AppData = {
                ...structuredClone(syncData),
                settings: {
                    pendingRemoteWriteAt: pendingAt,
                },
            };
            await io.writeLocal(pendingData);
            await io.writeRemote({
                ...pendingData,
                settings: {},
            });
            storeStateRef.current = {
                ...storeStateRef.current,
                lastDataChangeAt: 2,
            };
            getInMemoryAppDataSnapshotMock.mockReturnValue(editedAfterRemote);
            try {
                await io.writeLocal({
                    ...pendingData,
                    settings: {},
                });
            } catch (error) {
                await io.clearPendingRemoteWriteAfterLocalAbort?.(pendingAt);
                throw error;
            }
            throw new Error('Expected final local write to abort');
        });

        const result = await syncServiceModule.SyncService.performSync();
        const saveDataCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        const clearedData = saveDataCalls[saveDataCalls.length - 1]?.[1]?.data as AppData | undefined;

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(saveDataCalls).toHaveLength(2);
        expect(clearedData?.settings.pendingRemoteWriteAt).toBeUndefined();
        expect(clearedData?.tasks[0]?.title).toBe('Edited after remote write');
    });

    it('uses native Tauri commands for self-hosted Cloud data sync on desktop', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const localCloudData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const remoteCloudData: AppData = {
            tasks: [{
                id: 'remote-task',
                title: 'Remote',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2026-06-08T00:00:00.000Z',
                updatedAt: '2026-06-08T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const mergedCloudData: AppData = {
            ...structuredClone(remoteCloudData),
            tasks: [{
                ...remoteCloudData.tasks[0],
                title: 'Merged remote',
                updatedAt: '2026-06-08T00:01:00.000Z',
            }],
            settings: { lastSyncStatus: 'success' },
        };
        const httpFetchMock = vi.fn(async () => {
            throw new Error('JS HTTP helper should not perform Cloud data sync');
        });

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: {},
        };
        getInMemoryAppDataSnapshotMock.mockImplementation(() => structuredClone(localCloudData));
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_sync_cloud_provider') return 'selfhosted';
            if (command === 'get_cloud_config') return {
                url: 'https://sync.example.com',
                token: 'cloud-token',
                allowInsecureHttp: false,
            };
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localCloudData);
            if (command === 'save_data') return undefined;
            if (command === 'cloud_get_json') return structuredClone(remoteCloudData);
            if (command === 'cloud_put_json') return true;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => httpFetchMock as unknown as typeof fetch,
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<void>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            await io.readLocal();
            await expect(io.readRemote()).resolves.toEqual(remoteCloudData);
            await io.writeRemote(mergedCloudData);
            await io.writeLocal(mergedCloudData);
            return { status: 'success', stats: emptyStats, data: mergedCloudData };
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(invokeMock).toHaveBeenCalledWith('cloud_get_json', undefined);
        expect(invokeMock).toHaveBeenCalledWith('cloud_put_json', {
            data: expect.objectContaining({
                tasks: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'remote-task',
                        title: 'Merged remote',
                    }),
                ]),
            }),
        });
        expect(invokeMock).toHaveBeenCalledWith('save_data', {
            baselineEntities: {
                settings: {},
                observedEntityIds: entityIds(),
            },
            data: expect.objectContaining({
                tasks: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'remote-task',
                        title: 'Merged remote',
                    }),
                ]),
                settings: expect.objectContaining(mergedCloudData.settings),
            }),
        });
        expect(httpFetchMock).not.toHaveBeenCalledWith(
            'https://sync.example.com/v1/data',
            expect.objectContaining({ method: 'GET' })
        );
        expect(httpFetchMock).not.toHaveBeenCalledWith(
            'https://sync.example.com/v1/data',
            expect.objectContaining({ method: 'PUT' })
        );
    });

    it('uses a session-only WebDAV config for its proving round trip', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
        };
        const pendingRemote: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const httpFetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'PUT') {
                return buildResponse(200, '', { etag: '"pending-write"' });
            }
            return buildResponse(200, JSON.stringify(pendingRemote), { etag: '"pending-read"' });
        });
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(pendingRemote);
            if (command === 'save_data') return undefined;
            if (command === 'get_webdav_password') return 'persisted-password';
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => httpFetchMock as unknown as typeof fetch,
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<AppData | void>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const local = await io.readLocal();
            await expect(io.readRemote()).resolves.toEqual(pendingRemote);
            const candidate = await io.writeLocal(local) ?? local;
            await io.writeRemote(candidate);
            return { status: 'success', stats: emptyStats, data: candidate };
        });

        const result = await syncServiceModule.SyncService.performSync({
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'webdav',
                webdav: {
                    url: 'https://pending.example.com/mindwtr',
                    username: 'pending-user',
                    password: 'pending-password',
                    allowInsecureHttp: false,
                },
            },
        });

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(invokeMock).not.toHaveBeenCalledWith('get_sync_backend', undefined);
        expect(invokeMock).not.toHaveBeenCalledWith('get_webdav_config', undefined);
        expect(invokeMock).not.toHaveBeenCalledWith('webdav_get_json', undefined);
        expect(invokeMock).not.toHaveBeenCalledWith('webdav_put_json', expect.anything());
        expect(httpFetchMock).toHaveBeenCalledWith(
            'https://pending.example.com/mindwtr/data.json',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: `Basic ${btoa('pending-user:pending-password')}`,
                }),
            }),
        );
        expect(invokeMock.mock.calls.some(([command]) => command === 'save_data')).toBe(false);
        expect(applySyncedDataToStoreMock).not.toHaveBeenCalled();
        expect(externalCalendarGetMock).not.toHaveBeenCalled();
        expect(externalCalendarSetMock).not.toHaveBeenCalled();
    });

    it('does not persist candidate remote data when a desktop activation probe write fails', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
        };
        const pendingRemote: AppData = {
            tasks: [{
                id: 'remote-only',
                title: 'Remote only',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const httpFetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'PUT') throw new Error('candidate remote write failed');
            return buildResponse(200, JSON.stringify(pendingRemote), { etag: '"pending-read"' });
        });
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return {
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                people: [],
                settings: {},
            } satisfies AppData;
            if (command === 'get_webdav_password') return 'persisted-password';
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => httpFetchMock as unknown as typeof fetch,
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<AppData | void>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const local = await io.readLocal();
            const remote = await io.readRemote();
            const candidate = {
                ...local,
                tasks: [...local.tasks, ...(remote?.tasks ?? [])],
            };
            await io.writeLocal(candidate);
            await io.writeRemote(candidate);
            return { status: 'success', stats: emptyStats, data: candidate };
        });

        const result = await syncServiceModule.SyncService.performSync({
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'webdav',
                webdav: {
                    url: 'https://pending.example.com/mindwtr',
                    username: 'pending-user',
                    password: 'pending-password',
                    allowInsecureHttp: false,
                },
            },
        });

        expect(result).toMatchObject({ success: false, error: expect.stringContaining('candidate remote write failed') });
        expect(invokeMock.mock.calls.some(([command]) => command === 'save_data')).toBe(false);
        expect(applySyncedDataToStoreMock).not.toHaveBeenCalled();
        expect(storeStateRef.current._allTasks.some((task) => task.id === 'remote-only')).toBe(false);
    });

    it('only emits sync payload trace logs when diagnostics logging is enabled', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const syncedData: AppData = {
            tasks: [{
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                attachments: [{
                    id: 'att-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    cloudKey: 'attachments/att-1.txt',
                    localStatus: 'available',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const hasPayloadTraceLog = () => logInfoMock.mock.calls.some(([message]) =>
            typeof message === 'string' && message.startsWith('Sync trace')
        );
        const configureFileSync = () => {
            invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
                if (command === 'get_sync_backend') return 'file';
                if (command === 'get_sync_path') return '/sync/data.json';
                if (command === 'create_data_snapshot') return undefined;
                if (command === 'get_data') return structuredClone(syncedData);
                if (command === 'read_sync_file') return structuredClone(syncedData);
                if (command === 'save_data') return undefined;
                if (command === 'write_sync_file') return undefined;
                throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
            });
            performSyncCycleMock.mockImplementation(async (io: {
                readLocal: () => Promise<AppData>;
                readRemote: () => Promise<AppData | null>;
                writeLocal: (data: AppData) => Promise<void>;
                writeRemote: (data: AppData) => Promise<void>;
            }) => {
                const local = await io.readLocal();
                await io.readRemote();
                await io.writeLocal(local);
                await io.writeRemote(local);
                return { status: 'success', stats: emptyStats, data: local };
            });
        };

        configureFileSync();
        await syncServiceModule.SyncService.performSync();

        expect(hasPayloadTraceLog()).toBe(false);

        await syncServiceModule.SyncService.resetForTests();
        vi.clearAllMocks();
        configureFileSync();
        storeStateRef.current = {
            ...storeStateRef.current,
            settings: {
                diagnostics: { loggingEnabled: true },
            },
        };

        await syncServiceModule.SyncService.performSync();

        expect(hasPayloadTraceLog()).toBe(true);
    });

    it('preserves attachment pre-sync mutations when local edits land during file attachment sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        performSyncCycleMock.mockResolvedValue({
            status: 'success',
            stats: emptyStats,
            data: structuredClone(localData),
        });
        fsMocks.readFile.mockImplementation(async (path: string) => {
            if (path === '/local/doc.txt') {
                storeStateRef.current = {
                    ...storeStateRef.current,
                    _allTasks: storeStateRef.current._allTasks.map((task) =>
                        task.id === 'task-1'
                            ? { ...task, title: 'Edited during attachment sync', updatedAt: '2026-01-02T00:00:00.000Z' }
                            : task
                    ),
                    lastDataChangeAt: 2,
                };
            }
            return new Uint8Array([1, 2, 3]);
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(performSyncCycleMock).not.toHaveBeenCalled();
        expect(invokeMock).toHaveBeenCalledWith('save_data', {
            baselineEntities: {
                settings: {},
                tasks: [expect.objectContaining({
                    id: 'task-1',
                    attachments: [expect.objectContaining({ id: 'att-1' })],
                })],
                observedEntityIds: entityIds(['task-1']),
            },
            data: expect.objectContaining({
                tasks: [
                    expect.objectContaining({
                        id: 'task-1',
                        title: 'Edited during attachment sync',
                        attachments: [
                            expect.objectContaining({
                                id: 'att-1',
                                cloudKey: 'attachments/att-1.txt',
                                localStatus: 'available',
                            }),
                        ],
                    }),
                ],
            }),
        });
    });

    it('splits file backend cloud keys into native path segments for Windows sync folders', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'get_sync_path') return 'C:\\Users\\Pjuter\\Documents\\Mindwtr_sync\\data.json';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        pathMocks.join.mockImplementation(async (...parts: string[]) => {
            if (parts.slice(1).some((part) => part.includes('/'))) {
                throw new Error(`Invalid Windows path segment: ${parts.join(' | ')}`);
            }
            return `\\\\?\\${parts.join('\\')}`;
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(fsMocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\\\\\?\\C:\\Users\\Pjuter\\Documents\\Mindwtr_sync\\attachments\\att-1\.txt\.tmp-/),
            expect.any(Uint8Array),
        );
        expect(syncFsMocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\\\\\?\\C:\\Users\\Pjuter\\Documents\\Mindwtr_sync\\attachments\\att-1\.txt\.tmp-/),
            '\\\\?\\C:\\Users\\Pjuter\\Documents\\Mindwtr_sync\\attachments\\att-1.txt',
        );
    });

    it('cleans up the offline listener even when sync error logging fails', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
        const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_sync_cloud_provider') return 'selfhosted';
            if (command === 'get_cloud_config') return { url: '', token: '' };
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockRejectedValue(new Error('remote read failed'));
        logSyncErrorMock.mockRejectedValue(new Error('disk full'));

        try {
            const result = await syncServiceModule.SyncService.performSync();

            expect(result).toEqual({
                success: false,
                error: 'Error: remote read failed',
            });
            const addedOfflineListeners = addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'offline');
            const removedOfflineListeners = removeEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'offline');
            expect(addedOfflineListeners.length).toBeGreaterThan(0);
            const addedOfflineHandler = addedOfflineListeners[addedOfflineListeners.length - 1]?.[1];
            expect(removedOfflineListeners.some(([, handler]) => handler === addedOfflineHandler)).toBe(true);
            expect(syncServiceModule.SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                lastResult: 'error',
            });
            expect(logWarnMock).toHaveBeenCalledWith(
                'Failed to write sync error log',
                expect.objectContaining({
                    scope: 'sync',
                }),
            );
        } finally {
            addEventListenerSpy.mockRestore();
            removeEventListenerSpy.mockRestore();
        }
    });

    it('supports a one-off CloudKit sync before the backend is persisted', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'off';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
        }) => {
            const merged = await io.readLocal();
            expect(await io.readRemote()).toEqual({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                people: [],
                settings: {},
            });
            return { status: 'success', stats: emptyStats, data: merged };
        });

        const result = await syncServiceModule.SyncService.performSync({ backendOverride: 'cloudkit' });

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(ensureCloudKitReadyMock).toHaveBeenCalledTimes(1);
        expect(readRemoteCloudKitMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).not.toHaveBeenCalledWith('get_sync_backend', undefined);
    });

    it('skips file-sync writes when remote data only differs by device-local sync history', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const localSyncedData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {
                syncPreferences: { appearance: true },
                syncPreferencesUpdatedAt: {
                    appearance: '2026-04-16T00:00:00.000Z',
                    preferences: '2026-04-16T00:00:00.000Z',
                },
                theme: 'dark',
                lastSyncHistory: [
                    {
                        at: '2026-04-16T00:00:00.000Z',
                        status: 'success',
                        conflicts: 0,
                        conflictIds: [],
                        maxClockSkewMs: 0,
                        timestampAdjustments: 0,
                    },
                ],
            },
        };
        const remoteSyncedData: AppData = {
            ...localSyncedData,
            settings: {
                syncPreferences: { appearance: true },
                syncPreferencesUpdatedAt: {
                    appearance: '2026-04-16T00:00:00.000Z',
                    preferences: '2026-04-16T00:00:00.000Z',
                },
                theme: 'dark',
            },
        };

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: structuredClone(localSyncedData.settings),
        };

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'get_sync_path') return '/sync/data.json';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localSyncedData);
            if (command === 'read_sync_file_versioned') {
                return {
                    data: structuredClone(remoteSyncedData),
                    fingerprint: 'file:v1:sha256=remote-synced-data',
                    source: 'primary',
                    needsRepair: false,
                };
            }
            if (command === 'save_data') return undefined;
            if (command === 'write_sync_file') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<void>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const local = await io.readLocal();
            const remote = await io.readRemote();
            expect(remote).toEqual(remoteSyncedData);
            await io.writeRemote(local);
            await io.writeLocal(local);
            return { status: 'success', stats: emptyStats, data: local };
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(invokeMock.mock.calls.some(([command]) => command === 'write_sync_file')).toBe(false);
    });

    it('skips CloudKit writes when the sanitized remote payload is unchanged', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const syncedData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {
                syncPreferences: { appearance: true },
                theme: 'dark',
            },
        };

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: structuredClone(syncedData.settings),
        };
        readRemoteCloudKitMock.mockResolvedValue(structuredClone(syncedData));

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'off';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(syncedData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<void>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const local = await io.readLocal();
            const remote = await io.readRemote();
            expect(remote).toEqual(syncedData);
            await io.writeRemote(remote ?? syncedData);
            await io.writeLocal(local);
            return { status: 'success', stats: emptyStats, data: local };
        });

        const result = await syncServiceModule.SyncService.performSync({ backendOverride: 'cloudkit' });

        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(writeRemoteCloudKitMock).not.toHaveBeenCalled();
    });

    it('skips the full WebDAV merge when local and remote fingerprints are unchanged', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const syncedData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const remoteFingerprint = 'webdav:v1:etag="fast"';
        const scope = computeStableValueFingerprint({
            backend: 'webdav',
            url: 'https://sync.example.com/data.json',
            username: 'user',
        });
        const headFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('https://sync.example.com/data.json');
            expect(init?.method).toBe('HEAD');
            return buildResponse(200, '', { etag: '"fast"', 'content-length': '2' });
        });

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: syncedData.tasks,
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: {},
        };
        getInMemoryAppDataSnapshotMock.mockReturnValue(syncedData);
        localStorage.setItem('mindwtr-fast-sync-state-v1', JSON.stringify({
            scope,
            localFingerprint: computeSyncPayloadFingerprint(syncedData),
            remoteFingerprint,
            checkedAt: '2026-05-07T00:00:00.000Z',
        }));
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'webdav';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_webdav_config') {
                return {
                    url: 'https://sync.example.com/data.json',
                    username: 'user',
                    password: 'pass',
                    hasPassword: true,
                    allowInsecureHttp: false,
                };
            }
            if (command === 'get_data') return structuredClone(syncedData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => headFetchMock as unknown as typeof fetch,
        });

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'unchanged' });
        expect(performSyncCycleMock).not.toHaveBeenCalled();
        expect(headFetchMock).toHaveBeenCalled();
        expect(headFetchMock.mock.calls.some(([input, init]) =>
            init?.method === 'HEAD' || (typeof Request !== 'undefined' && input instanceof Request && input.method === 'HEAD')
        )).toBe(true);
        expect(headFetchMock.mock.calls).toHaveLength(1);
        expect(invokeMock.mock.calls.some(([command]) => command === 'save_data')).toBe(false);
        expect(JSON.parse(localStorage.getItem('mindwtr-local-sync-status-v1') ?? '{}')).toMatchObject({
            lastSyncStatus: 'success',
        });
        expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
        expect(fsMocks.readFile).not.toHaveBeenCalled();
    });

    it('reuses the fast-check local snapshot when falling back to a full WebDAV sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const syncedData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const remoteChangedData: AppData = {
            ...syncedData,
            settings: {
                syncPreferences: { appearance: true },
                theme: 'dark',
            },
        };
        const cachedRemoteFingerprint = 'webdav:v1:etag="old"';
        const freshRemoteFingerprint = 'webdav:v1:etag="new"';
        const scope = computeStableValueFingerprint({
            backend: 'webdav',
            url: 'https://sync.example.com/data.json',
            username: 'user',
        });
        const headFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('https://sync.example.com/data.json');
            expect(init?.method).toBe('HEAD');
            return buildResponse(200, '', { etag: '"new"', 'content-length': '2' });
        });

        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: {},
        };
        getInMemoryAppDataSnapshotMock.mockReturnValue(syncedData);
        localStorage.setItem('mindwtr-fast-sync-state-v1', JSON.stringify({
            scope,
            localFingerprint: computeSyncPayloadFingerprint(syncedData),
            remoteFingerprint: cachedRemoteFingerprint,
            checkedAt: '2026-05-07T00:00:00.000Z',
        }));
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'webdav';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_webdav_config') {
                return {
                    url: 'https://sync.example.com/data.json',
                    username: 'user',
                    password: 'pass',
                    hasPassword: true,
                    allowInsecureHttp: false,
                };
            }
            if (command === 'get_data') return structuredClone(syncedData);
            if (command === 'webdav_get_json') return structuredClone(remoteChangedData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => headFetchMock as unknown as typeof fetch,
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
        }) => {
            const local = await io.readLocal();
            const remote = await io.readRemote();
            expect(local.tasks).toEqual([]);
            expect(remote?.settings.theme).toBe('dark');
            return { status: 'success', stats: emptyStats, data: remoteChangedData };
        });

        const result = await syncServiceModule.SyncService.performSync();

        const getDataCalls = invokeMock.mock.calls.filter(([command]) => command === 'get_data');
        expect(result).toEqual({ success: true, stats: emptyStats });
        expect(getDataCalls).toHaveLength(1);
        expect(performSyncCycleMock).toHaveBeenCalledTimes(1);
        expect(headFetchMock).toHaveBeenCalled();
        expect(freshRemoteFingerprint).not.toBe(cachedRemoteFingerprint);
    });

    it('proves a first Dropbox connection with attachments using only the staged credential handle', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://content.dropboxapi.com/2/files/upload') {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer first-connect-token');
                return buildResponse(200, '{"rev":"attachment-rev"}');
            }
            if (url === 'https://content.dropboxapi.com/2/files/download') {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer first-connect-token');
                return buildResponse(200, JSON.stringify({
                    tasks: [],
                    projects: [],
                    sections: [],
                    areas: [],
                    people: [],
                    settings: {},
                }), { 'dropbox-api-result': '{"rev":"data-rev"}' });
            }
            throw new Error(`Unexpected Dropbox fetch input: ${url}`);
        });
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAppKey').mockResolvedValue('dropbox-app-key');
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchMock as unknown as typeof fetch,
        });
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: structuredClone(localData.tasks),
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: {},
        };
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'get_dropbox_access_token') {
                if (args?.credentialHandle !== 'first-connect-handle') {
                    throw new Error('Dropbox is not connected');
                }
                return 'first-connect-token';
            }
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            prepareRemoteWrite: (data: AppData) => Promise<AppData>;
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const candidateLocal = await io.readLocal();
            expect(candidateLocal.tasks[0]?.attachments?.[0]).toMatchObject({
                uri: '/local/doc.txt',
            });
            await io.readRemote();
            const provenCandidate = await io.prepareRemoteWrite(candidateLocal);
            expect(provenCandidate.tasks[0]?.attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/att-1.txt',
                localStatus: 'available',
            });
            await io.writeRemote(provenCandidate);
            return { status: 'success', stats: emptyStats, data: provenCandidate };
        });

        try {
            const result = await syncServiceModule.SyncService.performSync({
                activationProbe: true,
                configOverride: {
                    backend: 'cloud',
                    cloudProvider: 'dropbox',
                    dropboxCredentialHandle: 'first-connect-handle',
                },
                manual: true,
            });

            expect(result).toEqual(expect.objectContaining({ success: true }));
            const tokenCalls = invokeMock.mock.calls.filter(([command]) => (
                command === 'get_dropbox_access_token'
            ));
            expect(tokenCalls.length).toBeGreaterThan(0);
            expect(tokenCalls.every(([, args]) => (
                args?.credentialHandle === 'first-connect-handle'
            ))).toBe(true);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('never falls back to the old Dropbox account while refreshing reconnect attachment credentials', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        let attachmentUploadAttempts = 0;
        const authorizationHeaders: string[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const authorization = new Headers(init?.headers).get('Authorization') ?? '';
            authorizationHeaders.push(authorization);
            if (url === 'https://content.dropboxapi.com/2/files/upload') {
                attachmentUploadAttempts += 1;
                return attachmentUploadAttempts === 1
                    ? buildResponse(401, 'expired candidate token')
                    : buildResponse(200, '{"rev":"attachment-rev"}');
            }
            if (url === 'https://content.dropboxapi.com/2/files/download') {
                return buildResponse(200, JSON.stringify({
                    tasks: [],
                    projects: [],
                    sections: [],
                    areas: [],
                    people: [],
                    settings: {},
                }), { 'dropbox-api-result': '{"rev":"data-rev"}' });
            }
            throw new Error(`Unexpected Dropbox fetch input: ${url}`);
        });
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAppKey').mockResolvedValue('dropbox-app-key');
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchMock as unknown as typeof fetch,
        });
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: structuredClone(localData.tasks),
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: {},
        };
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localData);
            if (command === 'get_dropbox_access_token') {
                if (!args?.credentialHandle) return 'durable-old-account-token';
                return args.forceRefresh
                    ? 'refreshed-new-account-token'
                    : 'new-account-token';
            }
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            prepareRemoteWrite: (data: AppData) => Promise<AppData>;
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeRemote: (data: AppData) => Promise<void>;
        }) => {
            const candidateLocal = await io.readLocal();
            await io.readRemote();
            const provenCandidate = await io.prepareRemoteWrite(candidateLocal);
            await io.writeRemote(provenCandidate);
            return { status: 'success', stats: emptyStats, data: provenCandidate };
        });

        try {
            const result = await syncServiceModule.SyncService.performSync({
                activationProbe: true,
                configOverride: {
                    backend: 'cloud',
                    cloudProvider: 'dropbox',
                    dropboxCredentialHandle: 'reconnect-handle',
                },
                manual: true,
            });

            expect(result).toEqual(expect.objectContaining({ success: true }));
            expect(invokeMock).toHaveBeenCalledWith('get_dropbox_access_token', {
                clientId: 'dropbox-app-key',
                credentialHandle: 'reconnect-handle',
                forceRefresh: false,
            });
            expect(invokeMock).toHaveBeenCalledWith('get_dropbox_access_token', {
                clientId: 'dropbox-app-key',
                credentialHandle: 'reconnect-handle',
                forceRefresh: true,
            });
            expect(authorizationHeaders).toContain('Bearer new-account-token');
            expect(authorizationHeaders).toContain('Bearer refreshed-new-account-token');
            expect(authorizationHeaders).not.toContain('Bearer durable-old-account-token');
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('keeps a staged Dropbox handle bound to both initial and refreshed token resolution', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const remoteData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        let downloadAttempts = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) !== 'https://content.dropboxapi.com/2/files/download') {
                throw new Error(`Unexpected Dropbox fetch input: ${String(input)}`);
            }
            downloadAttempts += 1;
            return downloadAttempts === 1
                ? buildResponse(401, 'expired token')
                : buildResponse(200, JSON.stringify(remoteData), {
                    'dropbox-api-result': '{"rev":"rev-candidate"}',
                });
        });
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAppKey').mockResolvedValue('dropbox-app-key');
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: {},
        };
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchMock as unknown as typeof fetch,
        });
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(remoteData);
            if (command === 'get_dropbox_access_token') {
                return args?.forceRefresh
                    ? 'refreshed-staged-access-token'
                    : 'staged-access-token';
            }
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        performSyncCycleMock.mockImplementation(async (io: {
            readRemote: () => Promise<AppData | null>;
        }) => {
            const remote = await io.readRemote();
            return { status: 'success', stats: emptyStats, data: remote ?? remoteData };
        });

        try {
            const result = await syncServiceModule.SyncService.performSync({
                activationProbe: true,
                configOverride: {
                    backend: 'cloud',
                    cloudProvider: 'dropbox',
                    dropboxCredentialHandle: 'opaque-candidate-handle',
                },
                manual: true,
            });

            expect(result).toEqual(expect.objectContaining({ success: true }));
            expect(invokeMock).toHaveBeenCalledWith('get_dropbox_access_token', {
                clientId: 'dropbox-app-key',
                credentialHandle: 'opaque-candidate-handle',
                forceRefresh: false,
            });
            expect(invokeMock).toHaveBeenCalledWith('get_dropbox_access_token', {
                clientId: 'dropbox-app-key',
                credentialHandle: 'opaque-candidate-handle',
                forceRefresh: true,
            });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('falls back to browser fetch when native Dropbox download returns an empty body', async () => {
        const syncServiceModule = await syncServiceModulePromise;
        const dropboxRemoteData: AppData = {
            tasks: [
                {
                    id: 'remote-task-1',
                    title: 'Remote from Dropbox',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-04-23T00:00:00.000Z',
                    updatedAt: '2026-04-23T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const localDropboxData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const nativeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === 'https://content.dropboxapi.com/2/files/download') {
                return buildResponse(200, '', { 'dropbox-api-result': '{"rev":"rev-native"}' });
            }
            throw new Error(`Unexpected native fetch input: ${String(input)}`);
        });
        const browserFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === 'https://content.dropboxapi.com/2/files/download') {
                return buildResponse(200, JSON.stringify(dropboxRemoteData), { 'dropbox-api-result': '{"rev":"rev-browser"}' });
            }
            throw new Error(`Unexpected browser fetch input: ${String(input)}`);
        });
        const originalFetch = globalThis.fetch;

        globalThis.fetch = browserFetchMock as unknown as typeof fetch;
        storeStateRef.current = {
            ...storeStateRef.current,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            settings: {},
        };

        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_sync_cloud_provider') return 'dropbox';
            if (command === 'get_dropbox_access_token') return 'dropbox-token';
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localDropboxData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => nativeFetchMock as unknown as typeof fetch,
        });
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAppKey').mockResolvedValue('dropbox-app-key');
        performSyncCycleMock.mockImplementation(async (io: {
            readLocal: () => Promise<AppData>;
            readRemote: () => Promise<AppData | null>;
            writeLocal: (data: AppData) => Promise<void>;
        }) => {
            const remote = await io.readRemote();
            expect(remote).toEqual(dropboxRemoteData);
            await io.writeLocal(remote ?? localDropboxData);
            return { status: 'success', stats: emptyStats, data: remote ?? localDropboxData };
        });

        try {
            const result = await syncServiceModule.SyncService.performSync();

            expect(result).toEqual({ success: true, stats: emptyStats });
            expect(nativeFetchMock).toHaveBeenCalledTimes(1);
            expect(browserFetchMock).toHaveBeenCalledTimes(1);
            expect(logInfoMock).toHaveBeenCalledWith(
                'Retrying Dropbox remote read with browser fetch fallback',
                expect.objectContaining({ scope: 'sync' }),
            );
            expect(logInfoMock).toHaveBeenCalledWith(
                'Recovered Dropbox remote read via browser fetch fallback',
                expect.objectContaining({ scope: 'sync' }),
            );
            expect(invokeMock).toHaveBeenCalledWith('save_data', {
                data: dropboxRemoteData,
                baselineEntities: {
                    observedEntityIds: entityIds(),
                },
            });
        } finally {
            globalThis.fetch = originalFetch;
            vi.restoreAllMocks();
        }
    });
});
