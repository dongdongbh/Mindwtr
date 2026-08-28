import {
    addBreadcrumb,
    assertBackupSourceFileSize,
    assertImportSourceFileSize,
    countActiveRecords,
    createBackupFileName,
    flushPendingSave,
    serializeBackupData,
    type AppData,
    type MergeResult,
    type Task,
    useTaskStore,
} from '@mindwtr/core';
import {
    parseImportSource,
    runImport,
    type DataTransferBoundaries,
    type ImportPickerSourceId,
    type ImportSourceParseResultMap,
} from '@mindwtr/core/import-runner';
import {
    type DgtImportExecutionResult,
    type ParsedDgtImportData,
} from '@mindwtr/core/dgt-import';
import {
    type OmniFocusImportExecutionResult,
    type ParsedOmniFocusImportData,
} from '@mindwtr/core/omnifocus-import';
import {
    type ParsedTodoistProject,
    type TodoistImportExecutionResult,
} from '@mindwtr/core/todoist-import';
import {
    type ParsedTickTickImportData,
    type TickTickImportExecutionResult,
} from '@mindwtr/core/ticktick-import';
import {
    type MindwtrCsvImportExecutionResult,
    type ParsedMindwtrCsvImportData,
} from '@mindwtr/core/mindwtr-csv-import';
import { serializeMindwtrCsv } from '@mindwtr/core/mindwtr-csv-export';
import { buildTaskNotesExportZip } from '@mindwtr/core/tasknotes-export';

import { SyncService } from './sync-service';
import { tauriStorage } from './storage-adapter';
import { webStorage } from './storage-adapter-web';
import { isTauriRuntime } from './runtime';
import { logError, logInfo } from './app-log';

type TransferMode = 'binary' | 'text';

export type DesktopTransferDocument = {
    bytes?: Uint8Array;
    fileName: string;
    lastModified?: number | null;
    text?: string;
};

type DesktopTransferResult = {
    snapshotName: string | null;
};

const toCountExtra = (data: AppData): Record<string, string> => {
    const counts = countActiveRecords(data);
    return {
        tasks: String(counts.tasks),
        projects: String(counts.projects),
        sections: String(counts.sections),
        areas: String(counts.areas),
        people: String(counts.people),
    };
};

const getStorage = () => (isTauriRuntime() ? tauriStorage : webStorage);

const getLocalChangeAt = (): number => useTaskStore.getState().lastDataChangeAt;

const basename = (value: string): string => {
    const parts = String(value || '').split(/[\\/]/u);
    return parts[parts.length - 1] || value;
};

const pickBrowserFile = (accept: string): Promise<File | null> => new Promise((resolve) => {
    if (typeof document === 'undefined') {
        resolve(null);
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
});

const pickTransferDocument = async (
    options: {
        accept: string;
        extensions: string[];
        mode: TransferMode;
        title: string;
    }
): Promise<DesktopTransferDocument | null> => {
    if (isTauriRuntime()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            filters: [{ name: options.title, extensions: options.extensions }],
            multiple: false,
            title: options.title,
        });
        if (!selected || typeof selected !== 'string') return null;
        const { readFile, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
        const info = await stat(selected);
        if (options.mode === 'binary') assertImportSourceFileSize(info.size);
        else assertBackupSourceFileSize(info.size);
        return options.mode === 'binary'
            ? {
                bytes: await readFile(selected),
                fileName: basename(selected),
                lastModified: info.mtime?.getTime() ?? null,
            }
            : {
                text: await readTextFile(selected),
                fileName: basename(selected),
                lastModified: info.mtime?.getTime() ?? null,
            };
    }

    const file = await pickBrowserFile(options.accept);
    if (!file) return null;
    if (options.mode === 'binary') assertImportSourceFileSize(file.size);
    else assertBackupSourceFileSize(file.size);
    return options.mode === 'binary'
        ? {
            bytes: new Uint8Array(await file.arrayBuffer()),
            fileName: file.name,
            lastModified: file.lastModified,
        }
        : {
            text: await file.text(),
            fileName: file.name,
            lastModified: file.lastModified,
        };
};

const downloadTextFile = async (
    fileName: string,
    text: string,
    format: { name: string; extension: string; mimeType: string } = { name: 'JSON', extension: 'json', mimeType: 'application/json' },
): Promise<void> => {
    if (isTauriRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const selected = await save({
            defaultPath: fileName,
            filters: [{ name: format.name, extensions: [format.extension] }],
            title: 'Export backup',
        });
        if (!selected || typeof selected !== 'string') return;
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(selected, text);
        return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Browser download is unavailable in this environment.');
    }

    const blob = new Blob([text], { type: format.mimeType });
    const url = window.URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
    } finally {
        window.URL.revokeObjectURL(url);
    }
};

const desktopBoundaries: DataTransferBoundaries = {
    flushPendingSave,
    getCurrentChangeAt: getLocalChangeAt,
    readCurrentData: () => getStorage().getData(),
    createRecoverySnapshot: async () => (
        isTauriRuntime() ? SyncService.createDataSnapshot() : null
    ),
    persistData: async (data) => {
        await getStorage().saveData(data);
    },
    refreshData: () => useTaskStore.getState().fetchData({ silent: true }),
    onStale: ({ operation: staleOperation, localSnapshotChangeAt, currentChangeAt }) => {
        void logInfo('Data transfer aborted after local data changed', {
            scope: 'transfer',
            extra: {
                operation: staleOperation,
                snapshotChangeAt: String(localSnapshotChangeAt),
                currentChangeAt: String(currentChangeAt),
            },
        });
    },
};

export const createDesktopRecoverySnapshot = async (): Promise<string | null> => {
    await flushPendingSave();
    const localSnapshotChangeAt = getLocalChangeAt();
    const nativeRuntime = isTauriRuntime();
    const snapshotName = nativeRuntime ? await SyncService.createDataSnapshot() : null;
    if (nativeRuntime && !snapshotName) {
        throw new Error('Could not create a recovery snapshot. Try again.');
    }
    if (getLocalChangeAt() !== localSnapshotChangeAt) {
        throw new Error('Local data changed while creating the recovery snapshot. Try again.');
    }
    return snapshotName;
};

export const exportDesktopBackup = async (data: AppData): Promise<void> => {
    addBreadcrumb('transfer:export');
    void logInfo('Backup export started', {
        scope: 'transfer',
        extra: {
            operation: 'exportBackup',
            source: 'local',
        },
    });
    try {
        await flushPendingSave();
        await downloadTextFile(createBackupFileName(), serializeBackupData(data));
        void logInfo('Backup export complete', {
            scope: 'transfer',
            extra: {
                operation: 'exportBackup',
                source: 'local',
                ...toCountExtra(data),
            },
        });
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'exportBackup' } });
        throw error;
    }
};

/**
 * `tasks` narrows the export to a view's current result set (#1096) — `data`
 * stays the full dataset because that is where the serializer looks up project,
 * section and area titles.
 */
export const exportDesktopCsv = async (data: AppData, tasks?: readonly Task[]): Promise<void> => {
    addBreadcrumb('transfer:export');
    void logInfo('CSV export started', {
        scope: 'transfer',
        extra: { operation: 'exportCsv', source: 'local' },
    });
    try {
        await flushPendingSave();
        await downloadTextFile(
            createBackupFileName().replace(/\.json$/u, tasks ? '-filtered.csv' : '.csv'),
            serializeMindwtrCsv(data, tasks ? { tasks } : {}),
            { name: 'CSV', extension: 'csv', mimeType: 'text/csv' },
        );
        void logInfo('CSV export complete', {
            scope: 'transfer',
            extra: { operation: 'exportCsv', source: 'local', ...toCountExtra(data) },
        });
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'exportCsv' } });
        throw error;
    }
};

const downloadBinaryFile = async (
    fileName: string,
    bytes: Uint8Array,
    format: { name: string; extension: string; mimeType: string },
): Promise<void> => {
    if (isTauriRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const selected = await save({
            defaultPath: fileName,
            filters: [{ name: format.name, extensions: [format.extension] }],
            title: 'Export backup',
        });
        if (!selected || typeof selected !== 'string') return;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(selected, bytes);
        return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Browser download is unavailable in this environment.');
    }

    const blob = new Blob([bytes as BlobPart], { type: format.mimeType });
    const url = window.URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
    } finally {
        window.URL.revokeObjectURL(url);
    }
};

export const exportDesktopTaskNotes = async (data: AppData): Promise<void> => {
    addBreadcrumb('transfer:export');
    void logInfo('TaskNotes export started', {
        scope: 'transfer',
        extra: { operation: 'exportTaskNotes', source: 'local' },
    });
    try {
        await flushPendingSave();
        const { zip, fileCount } = buildTaskNotesExportZip(data);
        await downloadBinaryFile(
            createBackupFileName().replace(/\.json$/u, '-tasknotes.zip'),
            zip,
            { name: 'ZIP', extension: 'zip', mimeType: 'application/zip' },
        );
        void logInfo('TaskNotes export complete', {
            scope: 'transfer',
            extra: { operation: 'exportTaskNotes', source: 'local', fileCount: String(fileCount) },
        });
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'exportTaskNotes' } });
        throw error;
    }
};

export const inspectDesktopBackup = async (
    appVersion?: string | null,
): Promise<ImportSourceParseResultMap['backup'] | null> => {
    const document = await pickTransferDocument({
        accept: '.json,application/json',
        extensions: ['json'],
        mode: 'text',
        title: 'Mindwtr Backup',
    });
    if (!document?.text) return null;
    return parseImportSource('backup', {
        appVersion,
        fileName: document.fileName,
        lastModified: document.lastModified,
        text: document.text,
    });
};

// Core owns parser dispatch; only desktop file-picker metadata stays here.
type ImportPickerDescriptor = {
    accept: string;
    extensions: string[];
    title: string;
};

const IMPORT_PICKER_DESCRIPTORS: Record<ImportPickerSourceId, ImportPickerDescriptor> = {
    todoist: {
        accept: '.csv,.zip,text/csv,application/zip',
        extensions: ['csv', 'zip'],
        title: 'Todoist Export',
    },
    ticktick: {
        accept: '.csv,.zip,text/csv,application/zip',
        extensions: ['csv', 'zip'],
        title: 'TickTick Backup',
    },
    dgt: {
        accept: '.json,.zip,application/json,application/zip',
        extensions: ['json', 'zip'],
        title: 'DGT GTD Export',
    },
    omnifocus: {
        accept: '.csv,.json,.zip,text/csv,application/json,application/zip,application/octet-stream',
        extensions: ['csv', 'json', 'zip'],
        title: 'OmniFocus Export',
    },
    'mindwtr-csv': {
        accept: '.csv,.zip,text/csv,application/zip',
        extensions: ['csv', 'zip'],
        title: 'Mindwtr CSV',
    },
};

const inspectDesktopImportSource = async <S extends ImportPickerSourceId>(
    source: S
): Promise<ImportSourceParseResultMap[S] | null> => {
    const descriptor = IMPORT_PICKER_DESCRIPTORS[source];
    const document = await pickTransferDocument({
        accept: descriptor.accept,
        extensions: descriptor.extensions,
        mode: 'binary',
        title: descriptor.title,
    });
    if (!document) return null;
    return parseImportSource(source, { bytes: document.bytes, fileName: document.fileName });
};

export const inspectDesktopTodoistImport = (): Promise<ImportSourceParseResultMap['todoist'] | null> =>
    inspectDesktopImportSource('todoist');

export const inspectDesktopTickTickImport = (): Promise<ImportSourceParseResultMap['ticktick'] | null> =>
    inspectDesktopImportSource('ticktick');

export const inspectDesktopDgtImport = (): Promise<ImportSourceParseResultMap['dgt'] | null> =>
    inspectDesktopImportSource('dgt');

export const inspectDesktopOmniFocusImport = (): Promise<ImportSourceParseResultMap['omnifocus'] | null> =>
    inspectDesktopImportSource('omnifocus');

export const inspectDesktopMindwtrCsvImport = (): Promise<ImportSourceParseResultMap['mindwtr-csv'] | null> =>
    inspectDesktopImportSource('mindwtr-csv');

const desktopLog = { logInfo, logError };

export const restoreDesktopBackup = async (data: AppData): Promise<DesktopTransferResult> => {
    const { snapshotName } = await runImport('backup', data, desktopBoundaries, desktopLog);
    return { snapshotName };
};

export const mergeDesktopBackup = (
    data: AppData
): Promise<DesktopTransferResult & { result: MergeResult }> =>
    runImport('backup-merge', data, desktopBoundaries, desktopLog);

export const importDesktopTodoistData = (
    parsedProjects: ParsedTodoistProject[]
): Promise<DesktopTransferResult & { result: TodoistImportExecutionResult }> =>
    runImport('todoist', parsedProjects, desktopBoundaries, desktopLog);

export const importDesktopTickTickData = (
    parsedData: ParsedTickTickImportData
): Promise<DesktopTransferResult & { result: TickTickImportExecutionResult }> =>
    runImport('ticktick', parsedData, desktopBoundaries, desktopLog);

export const importDesktopDgtData = (
    parsedData: ParsedDgtImportData
): Promise<DesktopTransferResult & { result: DgtImportExecutionResult }> =>
    runImport('dgt', parsedData, desktopBoundaries, desktopLog);

export const importDesktopOmniFocusData = (
    parsedData: ParsedOmniFocusImportData
): Promise<DesktopTransferResult & { result: OmniFocusImportExecutionResult }> =>
    runImport('omnifocus', parsedData, desktopBoundaries, desktopLog);

export const importDesktopMindwtrCsvData = (
    parsedData: ParsedMindwtrCsvImportData
): Promise<DesktopTransferResult & { result: MindwtrCsvImportExecutionResult }> =>
    runImport('mindwtr-csv', parsedData, desktopBoundaries, desktopLog);
