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

const invokeMock = vi.hoisted(() => vi.fn());
const markLocalWriteMock = vi.hoisted(() => vi.fn());
const flushPendingSaveMock = vi.hoisted(() => vi.fn());
const performSyncCycleMock = vi.hoisted(() => vi.fn());
const getInMemoryAppDataSnapshotMock = vi.hoisted(() => vi.fn());
const useTaskStoreGetStateMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const logSyncErrorMock = vi.hoisted(() => vi.fn());
const externalCalendarGetMock = vi.hoisted(() => vi.fn());
const externalCalendarSetMock = vi.hoisted(() => vi.fn());
const fsMocks = vi.hoisted(() => ({
    BaseDirectory: { Data: 'data' },
    exists: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
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

vi.mock('./runtime', () => ({
    isTauriRuntime: () => true,
}));

vi.mock('./local-data-watcher', () => ({
    markLocalWrite: markLocalWriteMock,
}));

vi.mock('./external-calendar-service', () => ({
    ExternalCalendarService: {
        getCalendars: externalCalendarGetMock,
        setCalendars: externalCalendarSetMock,
    },
}));

vi.mock('./app-log', () => ({
    logInfo: logInfoMock,
    logWarn: logWarnMock,
    logSyncError: logSyncErrorMock,
    sanitizeLogMessage: (value: string) => value,
}));

vi.mock('./report-error', () => ({
    reportError: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);

vi.mock('@tauri-apps/api/path', () => pathMocks);

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    return {
        ...actual,
        flushPendingSave: flushPendingSaveMock,
        performSyncCycle: performSyncCycleMock,
        getInMemoryAppDataSnapshot: getInMemoryAppDataSnapshotMock,
        useTaskStore: {
            getState: useTaskStoreGetStateMock,
        },
    };
});

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

        fsMocks.exists.mockImplementation(async (path: string) => path === '/local/doc.txt');
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
        fsMocks.writeFile.mockResolvedValue(undefined);
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
        });
        await syncServiceModule.SyncService.resetForTests();
    });

    it('persists pre-synced attachment metadata when local changes abort the sync', async () => {
        const syncServiceModule = await syncServiceModulePromise;

        const result = await syncServiceModule.SyncService.performSync();

        expect(result).toEqual({ success: true });
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

        expect(result).toEqual({ success: true });
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
});
