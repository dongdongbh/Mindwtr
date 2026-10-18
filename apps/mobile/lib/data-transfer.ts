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
    IMPORT_PICKER_MIME_TYPES,
    isSandboxMode,
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

const assertPersonalWorkspace = (): void => {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox');
};
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
    assertPersonalWorkspace();
    await runDataTransferTransactionWithoutSnapshot({
        ...mobileDataTransferBoundaries(),
        operation,
        apply: (currentData) => ({ data: applyData(currentData), result: undefined }),
    });
};

export const pickBackupDocument = async (): Promise<TransferDocument | null> => {
    assertPersonalWorkspace();
    return pickDocument('application/json');
};

export const inspectBackupDocument = async (
    document: TransferDocument,
    options?: { appVersion?: string | null }
): Promise<ImportSourceParseResultMap['backup']> => {
    assertPersonalWorkspace();
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

// Core owns parser dispatch and each importer's picker types (IMPORT_PICKER_MIME_TYPES).
const pickImportDocument = (source: ImportPickerSourceId): Promise<TransferDocument | null> =>
    isSandboxMode()
        ? Promise.reject(new Error('Unavailable in sandbox'))
        : pickDocument([...IMPORT_PICKER_MIME_TYPES[source]]);

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
    assertPersonalWorkspace();
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
    assertPersonalWorkspace();
    const { snapshotName } = await runImport('backup', backupData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string };
};

export const mergeDataFromBackup = async (
    backupData: AppData
): Promise<SnapshotApplyResult & { result: MergeResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('backup-merge', backupData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importTodoistData = async (
    parsedProjects: ParsedTodoistProject[]
): Promise<SnapshotApplyResult & { result: TodoistImportExecutionResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('todoist', parsedProjects, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importTickTickData = async (
    parsedData: ParsedTickTickImportData
): Promise<SnapshotApplyResult & { result: TickTickImportExecutionResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('ticktick', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importDgtData = async (
    parsedData: ParsedDgtImportData
): Promise<SnapshotApplyResult & { result: DgtImportExecutionResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('dgt', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importOmniFocusData = async (
    parsedData: ParsedOmniFocusImportData
): Promise<SnapshotApplyResult & { result: OmniFocusImportExecutionResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('omnifocus', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const importMindwtrCsvData = async (
    parsedData: ParsedMindwtrCsvImportData
): Promise<SnapshotApplyResult & { result: MindwtrCsvImportExecutionResult }> => {
    assertPersonalWorkspace();
    const { result, snapshotName } = await runImport('mindwtr-csv', parsedData, mobileBoundaries, mobileLog);
    return { snapshotName: snapshotName as string, result };
};

export const listLocalDataSnapshots = async (): Promise<string[]> => {
    if (isSandboxMode()) return [];
    const directory = getSnapshotDirectory();
    if (!directory?.exists) return [];
    pruneSnapshots(directory);
    return listSnapshotEntries(directory).map((entry) => entry.name);
};

export const restoreLocalDataSnapshot = async (snapshotName: string): Promise<void> => {
    assertPersonalWorkspace();
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
    // The same bound a picked backup gets, before the whole file is read into memory.
    if (typeof file.size === 'number') assertBackupSourceFileSize(file.size);
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

// A folder document whose write a process death cut short looks like a finished backup. Its URI is listed on disk right after
// the folder created it, before the first byte, and leaves once the write closed. A start's cleanup (next export or Data screen
// visit) deletes only a URI an earlier run listed, never a file found by name: a death between the create and the listing
// leaves one empty document (accepted). An entry leaves only once its document is confirmed gone, so a provider that refused
// the delete keeps it for the next try.
const EXPORT_PENDING_FILE_NAME = 'export-pending.json';
type ExportPendingEntry = { uri: string; owner?: string };
// This JS runtime's entries: a cleanup never touches an export still running in it.
const EXPORT_PENDING_OWNER = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const exportPendingFiles = (): { record: File; pending: File } | null => {
    const baseUri = String(Paths.document?.uri ?? FileSystem.documentDirectory ?? '').trim().replace(/\/$/u, '');
    return baseUri
        ? { record: new File(`${baseUri}/${EXPORT_PENDING_FILE_NAME}`), pending: new File(`${baseUri}/${EXPORT_PENDING_FILE_NAME}.pending`) }
        : null;
};
const sameEntry = (left: ExportPendingEntry, right: ExportPendingEntry): boolean => left.uri === right.uri && left.owner === right.owner;

// The list, or null when the file is not a whole list. The older form `{ uri }` (one entry) is read too.
const parseExportPending = (file: File): ExportPendingEntry[] | null => {
    if (!file.exists) return null;
    try {
        const parsed = JSON.parse(file.textSync()) as { pending?: unknown; uri?: unknown };
        if (typeof parsed.uri === 'string') return [{ uri: parsed.uri }];
        if (!Array.isArray(parsed.pending)) return null;
        return parsed.pending.flatMap((entry): ExportPendingEntry[] => {
            if (typeof entry === 'string') return [{ uri: entry }];
            if (!entry || typeof entry !== 'object') return [];
            const { uri, owner } = entry as Record<string, unknown>;
            return typeof uri === 'string' ? [{ uri, owner: typeof owner === 'string' ? owner : undefined }] : [];
        });
    } catch {
        return null;
    }
};

// A whole pending file is the newest list (its replace was cut short); else the record.
const readExportPending = (): ExportPendingEntry[] => {
    const files = exportPendingFiles();
    if (!files) return [];
    return parseExportPending(files.pending) ?? parseExportPending(files.record) ?? [];
};

// Read and write with no await between them, so a cleanup and an export never drop each other's entries. The new list is
// written whole to a pending file, then replaces the record. Throws when it cannot be written: the caller then treats its
// write as failed.
const updateExportPending = (change: (pending: ExportPendingEntry[]) => ExportPendingEntry[]): void => {
    const files = exportPendingFiles();
    if (!files) return;
    const next = change(readExportPending());
    // A whole pending list a death left behind is the newest: it becomes the record before the pending file is reused, so a
    // second death in this write still finds it.
    if (parseExportPending(files.pending) !== null) {
        if (files.record.exists) files.record.delete();
        files.pending.move(files.record);
    }
    const pending = exportPendingFiles()!.pending;
    if (!pending.exists) pending.create({ intermediates: true, overwrite: true });
    pending.write(JSON.stringify({ pending: next }));
    if (files.record.exists) files.record.delete();
    pending.move(files.record);
};

// Deleted, then confirmed gone: Expo's delete can resolve although the provider kept the file.
const deleteExportDocument = async (uri: string): Promise<boolean> => {
    await StorageAccessFramework.deleteAsync(uri, { idempotent: true });
    return (await FileSystem.getInfoAsync(uri)).exists === false;
};

export const cleanupInterruptedBackupExport = async (): Promise<void> => {
    if (!StorageAccessFramework) return;
    const listed = readExportPending().filter((entry) => entry.owner !== EXPORT_PENDING_OWNER);
    for (const entry of listed) {
        try {
            if (entry.uri.startsWith('content://')) {
                if (!(await deleteExportDocument(entry.uri))) continue;
                void logInfo('Interrupted backup export removed', { scope: 'transfer', extra: { operation: 'exportBackup', releaseCheck: 'v1.3.5/mobile-export-cleanup' } });
            }
            updateExportPending((pending) => pending.filter((item) => !sameEntry(item, entry)));
        } catch (error) {
            // The entry stays: the next cleanup tries again.
            void logError(error, { scope: 'transfer', extra: { operation: 'exportBackup' } });
        }
    }
};

// One export path for both formats: the SAF/sharing dance below is identical,
// only the filename, body and mime type differ.
export const exportCurrentDataBackup = async (data: AppData, format: 'json' | 'csv' | 'tasknotes' = 'json'): Promise<void> => {
    assertPersonalWorkspace();
    addBreadcrumb('transfer:export');
    await cleanupInterruptedBackupExport();
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
            // Tracked outside the try so a failed write can remove the document
            // the picker already created in the user's folder.
            let createdFileUri: string | null = null;
            try {
                const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
                const directoryUri = permissions.directoryUri;
                if (permissions.granted && directoryUri) {
                    const fileUri = await StorageAccessFramework.createFileAsync(
                        directoryUri,
                        snapshotName,
                        mimeType
                    );
                    createdFileUri = fileUri;
                    // Listed before the first byte; a list that cannot take it fails the export, and the document goes below.
                    const created: ExportPendingEntry = { uri: fileUri, owner: EXPORT_PENDING_OWNER };
                    updateExportPending((pending) => [...pending, created]);
                    if (base64Content !== null) {
                        await StorageAccessFramework.writeAsStringAsync(fileUri, base64Content, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                    } else {
                        await StorageAccessFramework.writeAsStringAsync(fileUri, jsonContent);
                    }
                    // A list that cannot be updated fails the export: its document goes below, never later by surprise.
                    updateExportPending((pending) => pending.filter((entry) => !sameEntry(entry, created)));
                    void logInfo('Backup export complete', {
                        scope: 'transfer',
                        extra: {
                            operation: 'exportBackup',
                            source: 'local',
                            releaseCheck: 'v1.3.0/android-saf-backup-write',
                            ...toCountExtra(data),
                        },
                    });
                    return;
                }
            } catch (error) {
                void logError(error, { scope: 'transfer', extra: { operation: 'exportBackup' } });
                // Otherwise an empty file stays behind in the chosen folder and
                // looks like a finished backup. Best effort; the share fallback
                // below still runs either way.
                // Its entries stay listed unless the document is confirmed gone: the next start's cleanup tries again.
                if (createdFileUri) {
                    try {
                        const removed = createdFileUri;
                        if (await deleteExportDocument(removed)) {
                            updateExportPending((pending) => pending.filter((entry) => entry.owner !== EXPORT_PENDING_OWNER || entry.uri !== removed));
                        }
                    } catch (cleanupError) {
                        void logError(cleanupError, { scope: 'transfer', extra: { operation: 'exportBackup' } });
                    }
                }
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
