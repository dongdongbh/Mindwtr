import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

type MockStoreState = {
    _allTasks: AppData['tasks'];
    _allProjects: AppData['projects'];
    _allSections: AppData['sections'];
    _allAreas: AppData['areas'];
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
const flushPendingSaveMock = vi.hoisted(() => vi.fn());
const performSyncCycleMock = vi.hoisted(() => vi.fn());
const getInMemoryAppDataSnapshotMock = vi.hoisted(() => vi.fn());
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
        lastDataChangeAt: 1,
        settings: {},
        fetchData: vi.fn(),
        updateSettings: vi.fn(),
        setError: vi.fn(),
    } as MockStoreState,
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);

vi.mock('@tauri-apps/api/path', () => pathMocks);

const syncServiceModulePromise = import('./sync-service');

describe('desktop sync-service runtime', () => {
    beforeEach(async () => {
        vi.clearAllMocks();

        storeStateRef.current = {
            _allTasks: structuredClone(localData.tasks),
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
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
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }));
        externalCalendarGetMock.mockResolvedValue([]);
        externalCalendarSetMock.mockResolvedValue(undefined);
        logSyncErrorMock.mockResolvedValue(null);
        ensureCloudKitReadyMock.mockResolvedValue(undefined);
        readRemoteCloudKitMock.mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
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

        const syncServiceModule = await syncServiceModulePromise;
        syncServiceModule.__syncServiceTestUtils.resetDependenciesForTests();
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            getStoreState: useTaskStoreGetStateMock as typeof useTaskStoreGetStateMock,
            flushPendingSave: flushPendingSaveMock as typeof flushPendingSaveMock,
            performSyncCycle: performSyncCycleMock as typeof performSyncCycleMock,
            getInMemoryAppDataSnapshot: getInMemoryAppDataSnapshotMock as typeof getInMemoryAppDataSnapshotMock,
            markLocalWrite: markLocalWriteMock as typeof markLocalWriteMock,
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
        await syncServiceModule.SyncService.resetForTests();
    }, 30_000);

    it('persists pre-synced attachment metadata when local changes abort the sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(markLocalWriteMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('save_data', {
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
        expect(fsMocks.rename).toHaveBeenCalledWith(
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
            if (command === 'read_sync_file') return structuredClone(remoteSyncedData);
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

        localStorage.setItem('mindwtr-cloud-provider', 'dropbox');
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
            if (command === 'create_data_snapshot') return undefined;
            if (command === 'get_data') return structuredClone(localDropboxData);
            if (command === 'save_data') return undefined;
            throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
        });
        syncServiceModule.__syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => nativeFetchMock as unknown as typeof fetch,
        });
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAppKey').mockResolvedValue('dropbox-app-key');
        vi.spyOn(syncServiceModule.SyncService, 'getDropboxAccessToken').mockResolvedValue('dropbox-token');
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
            expect(invokeMock).toHaveBeenCalledWith('save_data', { data: dropboxRemoteData });
        } finally {
            globalThis.fetch = originalFetch;
            localStorage.removeItem('mindwtr-cloud-provider');
            vi.restoreAllMocks();
        }
    });
});
