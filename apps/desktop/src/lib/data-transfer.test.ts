import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_IMPORT_SOURCE_LIMITS,
    MAX_BACKUP_SOURCE_BYTES,
    type AppData,
    type Task,
} from '@mindwtr/core';
import type { ParsedTodoistProject } from '@mindwtr/core/todoist-import';

const emptyData: AppData = {
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
};

const storageMocks = vi.hoisted(() => ({
    getData: vi.fn(),
    saveData: vi.fn(),
}));

const storeStateRef = vi.hoisted(() => ({
    current: {
        lastDataChangeAt: 1,
        fetchData: vi.fn(),
    },
}));

const coreMocks = vi.hoisted(() => ({
    flushPendingSave: vi.fn(),
    useTaskStoreGetState: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
    logError: vi.fn(),
    logInfo: vi.fn(),
}));

const runtimeRef = vi.hoisted(() => ({ isTauri: false }));
const syncServiceMocks = vi.hoisted(() => ({
    createDataSnapshot: vi.fn(),
}));

const nativePickerMocks = vi.hoisted(() => ({
    open: vi.fn(),
    save: vi.fn(),
    readFile: vi.fn(),
    readTextFile: vi.fn(),
    stat: vi.fn(),
    writeTextFile: vi.fn(),
}));

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    return {
        ...actual,
        flushPendingSave: coreMocks.flushPendingSave,
        useTaskStore: {
            getState: coreMocks.useTaskStoreGetState,
        },
    };
});

vi.mock('./runtime', () => ({
    isTauriRuntime: () => runtimeRef.isTauri,
}));

vi.mock('./storage-adapter-web', () => ({
    webStorage: {
        getData: storageMocks.getData,
        saveData: storageMocks.saveData,
    },
}));

vi.mock('./storage-adapter', () => ({
    tauriStorage: {
        getData: storageMocks.getData,
        saveData: storageMocks.saveData,
    },
}));

vi.mock('./sync-service', () => ({
    SyncService: {
        createDataSnapshot: syncServiceMocks.createDataSnapshot,
    },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: nativePickerMocks.open,
    save: nativePickerMocks.save,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    readFile: nativePickerMocks.readFile,
    readTextFile: nativePickerMocks.readTextFile,
    stat: nativePickerMocks.stat,
    writeTextFile: nativePickerMocks.writeTextFile,
}));

vi.mock('./app-log', () => ({
    logError: logMocks.logError,
    logInfo: logMocks.logInfo,
}));

import {
    createDesktopRecoverySnapshot,
    exportDesktopCsv,
    importDesktopTodoistData,
    inspectDesktopMindwtrCsvImport,
    inspectDesktopBackup,
    mergeDesktopBackup,
} from './data-transfer';

const parsedProjects: ParsedTodoistProject[] = [{
    name: 'Todoist',
    sections: [],
    checklistItemCount: 0,
    recurringCount: 0,
    tasks: [{
        title: 'Imported task',
        tags: [],
        checklist: [],
    }],
}];

describe('desktop data transfer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeStateRef.current = {
            lastDataChangeAt: 1,
            fetchData: vi.fn().mockResolvedValue(undefined),
        };
        coreMocks.flushPendingSave.mockResolvedValue(undefined);
        coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
        storageMocks.getData.mockResolvedValue(emptyData);
        storageMocks.saveData.mockResolvedValue(undefined);
        runtimeRef.isTauri = false;
        syncServiceMocks.createDataSnapshot.mockResolvedValue('data.snapshot.json');
        nativePickerMocks.open.mockResolvedValue('/tmp/import.csv');
        nativePickerMocks.save.mockResolvedValue('/home/dd/export.csv');
        nativePickerMocks.stat.mockResolvedValue({ size: 0 });
        nativePickerMocks.readFile.mockResolvedValue(new Uint8Array());
        nativePickerMocks.writeTextFile.mockResolvedValue(undefined);
    });

    it('aborts Todoist import when local data changes before the full snapshot write', async () => {
        storageMocks.getData.mockImplementation(async () => {
            storeStateRef.current = {
                ...storeStateRef.current,
                lastDataChangeAt: 2,
            };
            return emptyData;
        });

        await expect(importDesktopTodoistData(parsedProjects)).rejects.toMatchObject({
            name: 'LocalSyncAbort',
        });

        expect(storageMocks.saveData).not.toHaveBeenCalled();
        expect(storeStateRef.current.fetchData).not.toHaveBeenCalled();
        expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
        expect(storageMocks.getData).toHaveBeenCalledOnce();
        expect(logMocks.logInfo).toHaveBeenCalledWith(
            'Data transfer aborted after local data changed',
            expect.objectContaining({
                scope: 'transfer',
                extra: expect.objectContaining({
                    operation: 'importTodoist',
                    snapshotChangeAt: '1',
                    currentChangeAt: '2',
                }),
            })
        );
    });

    it('persists and refreshes after a guarded Todoist import', async () => {
        const transfer = await importDesktopTodoistData(parsedProjects);

        expect(transfer.snapshotName).toBeNull();
        expect(transfer.result.importedTaskCount).toBe(1);
        expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
        expect(storageMocks.getData).toHaveBeenCalledOnce();
        expect(storageMocks.saveData).toHaveBeenCalledWith(expect.objectContaining({
            tasks: [expect.objectContaining({ title: 'Imported task' })],
        }));
        expect(storeStateRef.current.fetchData).toHaveBeenCalledWith({ silent: true });
    });

    it('keeps local tasks when merging a backup and reports what the backup added', async () => {
        const localTask = {
            id: 'local-1',
            title: 'Local task',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        storageMocks.getData.mockResolvedValue({ ...emptyData, tasks: [localTask] });

        const transfer = await mergeDesktopBackup({
            ...emptyData,
            tasks: [{ ...localTask, id: 'backup-1', title: 'Backup task' }],
        });

        expect(transfer.result.stats.tasks.incomingOnly).toBe(1);
        expect(storageMocks.saveData).toHaveBeenCalledWith(expect.objectContaining({
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: 'local-1' }),
                expect.objectContaining({ id: 'backup-1' }),
            ]),
        }));
    });

    it('creates a native recovery snapshot after pending saves finish', async () => {
        runtimeRef.isTauri = true;

        await expect(createDesktopRecoverySnapshot()).resolves.toBe('data.snapshot.json');

        expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
        expect(syncServiceMocks.createDataSnapshot).toHaveBeenCalledOnce();
        expect(coreMocks.flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(syncServiceMocks.createDataSnapshot.mock.invocationCallOrder[0]);
    });

    it('blocks a native import when the recovery snapshot cannot be created', async () => {
        runtimeRef.isTauri = true;
        syncServiceMocks.createDataSnapshot.mockResolvedValue(null);

        await expect(createDesktopRecoverySnapshot()).rejects.toThrow('Could not create a recovery snapshot');
    });

    it('rejects an oversized native import before reading it into memory', async () => {
        runtimeRef.isTauri = true;
        nativePickerMocks.stat.mockResolvedValue({
            size: DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes + 1,
        });

        await expect(inspectDesktopMindwtrCsvImport()).rejects.toThrow(
            'Choose a file no larger than 16 MB',
        );

        expect(nativePickerMocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects an oversized native backup before reading it into memory', async () => {
        runtimeRef.isTauri = true;
        nativePickerMocks.stat.mockResolvedValue({ size: MAX_BACKUP_SOURCE_BYTES + 1 });

        await expect(inspectDesktopBackup()).rejects.toThrow('backup file is too large');
        expect(nativePickerMocks.readTextFile).not.toHaveBeenCalled();
    });

    it('rejects a native backup whose size cannot be verified before reading', async () => {
        runtimeRef.isTauri = true;
        nativePickerMocks.stat.mockResolvedValue({});

        await expect(inspectDesktopBackup()).rejects.toThrow('could not verify the selected backup file size');
        expect(nativePickerMocks.readTextFile).not.toHaveBeenCalled();
    });

    it('returns false and does not report completion when the native CSV save is cancelled', async () => {
        runtimeRef.isTauri = true;
        nativePickerMocks.save.mockResolvedValue(null);

        await expect(exportDesktopCsv(emptyData)).resolves.toBe(false);

        expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
        expect(nativePickerMocks.writeTextFile).not.toHaveBeenCalled();
        expect(logMocks.logInfo).not.toHaveBeenCalledWith(
            'CSV export complete',
            expect.anything(),
        );
    });

    it('reports CSV success only after the native file write finishes', async () => {
        runtimeRef.isTauri = true;
        let finishWrite: (() => void) | undefined;
        nativePickerMocks.writeTextFile.mockImplementation(() => new Promise<void>((resolve) => {
            finishWrite = resolve;
        }));

        let result: boolean | undefined;
        const exporting = exportDesktopCsv(emptyData).then((completed) => {
            result = completed;
        });
        await vi.waitFor(() => expect(nativePickerMocks.writeTextFile).toHaveBeenCalledOnce());

        expect(result).toBeUndefined();
        expect(logMocks.logInfo).not.toHaveBeenCalledWith(
            'CSV export complete',
            expect.anything(),
        );

        finishWrite?.();
        await exporting;

        expect(result).toBe(true);
        expect(logMocks.logInfo).toHaveBeenCalledWith(
            'CSV export complete',
            expect.objectContaining({ scope: 'transfer' }),
        );
    });

    it('rejects and logs a native CSV write failure', async () => {
        runtimeRef.isTauri = true;
        const error = new Error('disk full');
        nativePickerMocks.writeTextFile.mockRejectedValue(error);

        await expect(exportDesktopCsv(emptyData)).rejects.toThrow('disk full');

        expect(logMocks.logError).toHaveBeenCalledWith(error, {
            scope: 'transfer',
            extra: { operation: 'exportCsv' },
        });
        expect(logMocks.logInfo).not.toHaveBeenCalledWith(
            'CSV export complete',
            expect.anything(),
        );
    });

    it('writes only the supplied filtered task subset', async () => {
        runtimeRef.isTauri = true;
        const makeTask = (id: string, title: string): Task => ({
            id,
            title,
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        const included = makeTask('included', 'Included task');
        const excluded = makeTask('excluded', 'Excluded task');

        await expect(exportDesktopCsv(
            { ...emptyData, tasks: [included, excluded] },
            [included],
        )).resolves.toBe(true);

        expect(nativePickerMocks.save).toHaveBeenCalledWith(expect.objectContaining({
            defaultPath: expect.stringMatching(/-filtered\.csv$/u),
        }));
        expect(nativePickerMocks.writeTextFile).toHaveBeenCalledWith(
            '/home/dd/export.csv',
            expect.stringContaining('Included task'),
        );
        expect(nativePickerMocks.writeTextFile.mock.calls[0]?.[1]).not.toContain('Excluded task');
    });
});
