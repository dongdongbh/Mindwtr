import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from './file-system';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import {
    addBreadcrumb,
    assertBackupSourceFileSize,
    assertImportSourceFileSize,
    BackupSourceFileError,
    countActiveRecords,
    createBackupFileName,
    flushPendingSave,
    prepareRestoredBackupDataForSync,
    runDataTransferTransactionWithoutSnapshot,
    serializeBackupData,
    type AppData,
    type MergeResult,
    useTaskStore,
    validateBackupJson,
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
import { logError, logInfo } from './app-log';
import {
    createMobileRecoverySnapshot,
    getLocalChangeAt,
    getSnapshotDirectory,
    listSnapshotEntries,
    pruneSnapshots,
    saveCurrentDataSnapshot,
    SNAPSHOT_FILE_PATTERN,
    toCountExtra,
} from './recovery-snapshot';
import { mobileStorage } from './storage-adapter';

const StorageAccessFramework = FileSystem.StorageAccessFramework;
// Deliberately does not match SNAPSHOT_FILE_PATTERN, so a half-written snapshot
// is invisible to the restore roster and to pruning.

export type TransferDocument = {
    fileName: string;
    lastModified?: number | null;
    size?: number | null;
    uri: string;
};

type SnapshotApplyResult = {
    snapshotName: string;
};








const readTextFile = async (fileUri: string): Promise<string> => {
    if (fileUri.startsWith('content://')) {
        if (!StorageAccessFramework?.readAsStringAsync) {
            throw new Error('This device cannot read the selected document.');
        }
        return await StorageAccessFramework.readAsStringAsync(fileUri);
    }

    if (Platform.OS === 'ios' && fileUri.startsWith('file://')) {
        try {
            const file = new File(fileUri);
            if (file.exists) {
                return await file.text();
            }
        } catch {
            // Fall back to legacy API below.
        }
    }

    return await FileSystem.readAsStringAsync(fileUri);
};

const readBinaryFile = async (fileUri: string): Promise<Uint8Array> => {
    if (fileUri.startsWith('content://')) {
        if (!StorageAccessFramework?.readAsStringAsync) {
            throw new Error('This device cannot read the selected document.');
        }
        const base64 = await StorageAccessFramework.readAsStringAsync(fileUri, {
            encoding: FileSystem.EncodingType.Base64,
        });
        return Uint8Array.from(Buffer.from(base64, 'base64'));
    }

    if (Platform.OS === 'ios' && fileUri.startsWith('file://')) {
        try {
            const file = new File(fileUri);
            if (file.exists) {
                return new Uint8Array(await file.bytes());
            }
        } catch {
            // Fall back to legacy API below.
        }
    }

    const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
    });
    return Uint8Array.from(Buffer.from(base64, 'base64'));
};

const pickDocument = async (type: string | string[]): Promise<TransferDocument | null> => {
    const result = await DocumentPicker.getDocumentAsync({
        type,
        copyToCacheDirectory: true,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset?.uri) return null;
    return {
        uri: asset.uri,
        fileName: asset.name || asset.uri.split('/').pop() || 'import',
        lastModified: asset.lastModified ?? null,
        size: asset.size ?? null,
    };
};


const logStaleDataTransfer = ({
    operation,
    localSnapshotChangeAt,
    currentChangeAt,
}: {
    operation: string;
    localSnapshotChangeAt: number;
    currentChangeAt: number;
}): void => {
    void logInfo('Data transfer aborted after local data changed', {
        scope: 'transfer',
        extra: {
            operation,
            snapshotChangeAt: String(localSnapshotChangeAt),
            currentChangeAt: String(currentChangeAt),
        },
    });
};

const mobileDataTransferBoundaries = (): Omit<DataTransferBoundaries, 'createRecoverySnapshot'> => ({
    flushPendingSave,
    getCurrentChangeAt: getLocalChangeAt,
    readCurrentData: () => mobileStorage.getData(),
    persistData: async (data: AppData): Promise<void> => {
        // Storage adapters may return their canonical persisted snapshot. The transfer contract
        // intentionally reloads through refreshData, so consume that return value here.
        await mobileStorage.saveData(data);
    },
    refreshData: () => useTaskStore.getState().fetchData({ silent: true }),
    onStale: logStaleDataTransfer,
});

const mobileBoundaries: DataTransferBoundaries = {
    ...mobileDataTransferBoundaries(),
    createRecoverySnapshot: saveCurrentDataSnapshot,
};

const mobileLog = { logInfo, logError };


const runMobileDataTransferWithoutSnapshot = async (
    operation: string,
    applyData: (currentData: AppData) => AppData
): Promise<void> => {
    await runDataTransferTransactionWithoutSnapshot({
        ...mobileDataTransferBoundaries(),
        operation,
        apply: (currentData) => ({ data: applyData(currentData), result: undefined }),
    });
};

export const pickBackupDocument = async (): Promise<TransferDocument | null> =>
    pickDocument('application/json');

export const inspectBackupDocument = async (
    document: TransferDocument,
    options?: { appVersion?: string | null }
): Promise<ImportSourceParseResultMap['backup']> => {
    const size = await resolveDocumentSize(document, 'backup');
    assertBackupSourceFileSize(size);
    const rawJson = await readTextFile(document.uri);
    return parseImportSource('backup', {
        appVersion: options?.appVersion,
        fileName: document.fileName,
        lastModified: document.lastModified,
        text: rawJson,
    });
};

// Core owns parser dispatch; only mobile document-picker metadata stays here.
type ImportPickerDescriptor = {
    mimeTypes: string[];
};

const IMPORT_PICKER_DESCRIPTORS: Record<ImportPickerSourceId, ImportPickerDescriptor> = {
    todoist: {
        mimeTypes: [
            'text/csv',
            'text/comma-separated-values',
            'application/zip',
            'application/x-zip-compressed',
            'application/octet-stream',
        ],
    },
    ticktick: {
        mimeTypes: [
            'text/csv',
            'text/comma-separated-values',
            'application/zip',
            'application/x-zip-compressed',
            'application/octet-stream',
        ],
    },
    dgt: {
        mimeTypes: [
            'application/json',
            'application/zip',
            'application/x-zip-compressed',
            'application/octet-stream',
        ],
    },
    omnifocus: {
        mimeTypes: [
            'text/csv',
            'text/comma-separated-values',
            'application/json',
            'application/zip',
            'application/x-zip-compressed',
            'application/octet-stream',
        ],
    },
    'mindwtr-csv': {
        mimeTypes: [
            'text/csv',
            'text/comma-separated-values',
            'application/zip',
            'application/x-zip-compressed',
            'application/octet-stream',
        ],
    },
};

const pickImportDocument = (source: ImportPickerSourceId): Promise<TransferDocument | null> =>
    pickDocument(IMPORT_PICKER_DESCRIPTORS[source].mimeTypes);

const resolveDocumentSize = async (document: TransferDocument, kind: 'backup' | 'import'): Promise<number> => {
    try {
        // The picker reports the source-provider metadata, but imports read the
        // URI copied into Mindwtr's cache. Stat that actual read target so stale
        // or dishonest metadata cannot bypass the pre-read memory bound.
        const info = await FileSystem.getInfoAsync(document.uri);
        if (info.exists && typeof info.size === 'number' && Number.isFinite(info.size) && info.size >= 0) {
            return info.size;
        }
    } catch {
        // The safe fallback for an unreadable provider is to stop before a bulk read.
    }
    if (kind === 'backup') {
        throw new BackupSourceFileError(
            'backup-source-size-unknown',
            'Mindwtr could not verify the selected backup file size. Copy it locally and try again.',
        );
    }
    throw new Error('Mindwtr could not verify the selected import file size. Copy it locally and try again.');
};

const inspectImportDocument = async <S extends ImportPickerSourceId>(
    source: S,
    document: TransferDocument
): Promise<ImportSourceParseResultMap[S]> => {
    const size = await resolveDocumentSize(document, 'import');
    assertImportSourceFileSize(size);
    const bytes = await readBinaryFile(document.uri);
    return parseImportSource(source, { bytes, fileName: document.fileName });
};

export const pickTodoistDocument = (): Promise<TransferDocument | null> => pickImportDocument('todoist');

export const pickTickTickDocument = (): Promise<TransferDocument | null> => pickImportDocument('ticktick');

export const pickDgtDocument = (): Promise<TransferDocument | null> => pickImportDocument('dgt');

export const pickOmniFocusDocument = (): Promise<TransferDocument | null> => pickImportDocument('omnifocus');

export const pickMindwtrCsvDocument = (): Promise<TransferDocument | null> => pickImportDocument('mindwtr-csv');

export const inspectTodoistDocument = (document: TransferDocument): Promise<ImportSourceParseResultMap['todoist']> =>
    inspectImportDocument('todoist', document);

export const inspectTickTickDocument = (document: TransferDocument): Promise<ImportSourceParseResultMap['ticktick']> =>
    inspectImportDocument('ticktick', document);

export const inspectDgtDocument = (document: TransferDocument): Promise<ImportSourceParseResultMap['dgt']> =>
    inspectImportDocument('dgt', document);

export const inspectOmniFocusDocument = (document: TransferDocument): Promise<ImportSourceParseResultMap['omnifocus']> =>
    inspectImportDocument('omnifocus', document);

export const inspectMindwtrCsvDocument = (document: TransferDocument): Promise<ImportSourceParseResultMap['mindwtr-csv']> =>
    inspectImportDocument('mindwtr-csv', document);

// Mobile's snapshot writer never returns null (unlike desktop's Tauri-only snapshot), so the
// shared `string | null` contract can be narrowed back for mobile's public result type.
export const restoreDataFromBackup = async (backupData: AppData): Promise<SnapshotApplyResult> => {
    const { snapshotName } = await runImport('backup', backupData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string };
};

export const mergeDataFromBackup = async (
    backupData: AppData
): Promise<SnapshotApplyResult & { result: MergeResult }> => {
    const { result, snapshotName } = await runImport('backup-merge', backupData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importTodoistData = async (
    parsedProjects: ParsedTodoistProject[]
): Promise<SnapshotApplyResult & { result: TodoistImportExecutionResult }> => {
    const { result, snapshotName } = await runImport('todoist', parsedProjects, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importTickTickData = async (
    parsedData: ParsedTickTickImportData
): Promise<SnapshotApplyResult & { result: TickTickImportExecutionResult }> => {
    const { result, snapshotName } = await runImport('ticktick', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importDgtData = async (
    parsedData: ParsedDgtImportData
): Promise<SnapshotApplyResult & { result: DgtImportExecutionResult }> => {
    const { result, snapshotName } = await runImport('dgt', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importOmniFocusData = async (
    parsedData: ParsedOmniFocusImportData
): Promise<SnapshotApplyResult & { result: OmniFocusImportExecutionResult }> => {
    const { result, snapshotName } = await runImport('omnifocus', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importMindwtrCsvData = async (
    parsedData: ParsedMindwtrCsvImportData
): Promise<SnapshotApplyResult & { result: MindwtrCsvImportExecutionResult }> => {
    const { result, snapshotName } = await runImport('mindwtr-csv', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const listLocalDataSnapshots = async (): Promise<string[]> => {
    const directory = getSnapshotDirectory();
    if (!directory?.exists) return [];
    pruneSnapshots(directory);
    return listSnapshotEntries(directory).map((entry) => entry.name);
};

export const restoreLocalDataSnapshot = async (snapshotName: string): Promise<void> => {
    addBreadcrumb('transfer:restore');
    void logInfo('Recovery snapshot restore started', {
        scope: 'transfer',
        extra: {
            operation: 'restoreSnapshot',
            source: 'snapshot',
        },
    });
    const directory = getSnapshotDirectory();
    if (!directory || !SNAPSHOT_FILE_PATTERN.test(snapshotName)) {
      throw new Error('Invalid snapshot file name.');
    }
    const file = new File(`${directory.uri}/${snapshotName}`);
    if (!file.exists) {
        throw new Error('Snapshot file not found.');
    }
    const validation = validateBackupJson(await file.text(), { fileName: snapshotName });
    if (!validation.valid || !validation.data) {
        throw new Error(validation.errors[0] || 'Snapshot is not a valid backup.');
    }

    try {
        await runMobileDataTransferWithoutSnapshot(
            'restoreSnapshot',
            (currentData) => prepareRestoredBackupDataForSync(validation.data!, {
                previousData: currentData,
            }),
        );
        void logInfo('Recovery snapshot restore complete', {
            scope: 'transfer',
            extra: {
                operation: 'restoreSnapshot',
                source: 'snapshot',
                ...toCountExtra(validation.data),
            },
        });
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'restoreSnapshot' } });
        throw error;
    }
};

// One export path for both formats: the SAF/sharing dance below is identical,
// only the filename, body and mime type differ.
export const exportCurrentDataBackup = async (data: AppData, format: 'json' | 'csv' | 'tasknotes' = 'json'): Promise<void> => {
    addBreadcrumb('transfer:export');
    const isCsv = format === 'csv';
    const isTaskNotes = format === 'tasknotes';
    const snapshotName = isTaskNotes
        ? createBackupFileName().replace(/\.json$/u, '-tasknotes.zip')
        : isCsv
            ? createBackupFileName().replace(/\.json$/u, '.csv')
            : createBackupFileName();
    // The TaskNotes export is a ZIP, written and shared as base64 bytes; the
    // other formats stay plain text.
    const base64Content = isTaskNotes
        ? Buffer.from(buildTaskNotesExportZip(data).zip).toString('base64')
        : null;
    const jsonContent = isTaskNotes ? '' : isCsv ? serializeMindwtrCsv(data) : serializeBackupData(data);
    const mimeType = isTaskNotes ? 'application/zip' : isCsv ? 'text/csv' : 'application/json';
    void logInfo('Backup export started', {
        scope: 'transfer',
        extra: {
            operation: 'exportBackup',
            source: 'local',
        },
    });

    try {
        if (Platform.OS === 'android' && StorageAccessFramework) {
            try {
                const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
                const directoryUri = permissions.directoryUri;
                if (permissions.granted && directoryUri) {
                    const fileUri = await StorageAccessFramework.createFileAsync(
                        directoryUri,
                        snapshotName,
                        mimeType
                    );
                    if (base64Content !== null) {
                        await StorageAccessFramework.writeAsStringAsync(fileUri, base64Content, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                    } else {
                        await StorageAccessFramework.writeAsStringAsync(fileUri, jsonContent);
                    }
                    void logInfo('Backup export complete', {
                        scope: 'transfer',
                        extra: {
                            operation: 'exportBackup',
                            source: 'local',
                            ...toCountExtra(data),
                        },
                    });
                    return;
                }
            } catch (error) {
                void logError(error, { scope: 'transfer', extra: { operation: 'exportBackup' } });
            }
        }

        const fileUri = `${FileSystem.cacheDirectory}${snapshotName}`;
        if (base64Content !== null) {
            await FileSystem.writeAsStringAsync(fileUri, base64Content, {
                encoding: FileSystem.EncodingType.Base64,
            });
        } else {
            await FileSystem.writeAsStringAsync(fileUri, jsonContent);
        }
        const Sharing = await import('expo-sharing');
        if (!(await Sharing.isAvailableAsync())) {
            throw new Error('Sharing is not available on this device.');
        }
        await Sharing.shareAsync(fileUri, {
            UTI: isTaskNotes ? 'public.zip-archive' : isCsv ? 'public.comma-separated-values-text' : 'public.json',
            mimeType,
            dialogTitle: 'Export Mindwtr Backup',
        });
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

// Settings-side callers keep importing this from data-transfer.
export { createMobileRecoverySnapshot } from './recovery-snapshot';
