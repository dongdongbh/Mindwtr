import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from './file-system';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import {
    addBreadcrumb,
    applyDgtImport,
    applyOmniFocusImport,
    applyTodoistImport,
    createBackupFileName,
    parseDgtImportSource,
    flushPendingSave,
    parseOmniFocusImportSource,
    parseTodoistImportSource,
    serializeBackupData,
    type OmniFocusImportExecutionResult,
    type OmniFocusImportParseResult,
    type ParsedOmniFocusImportData,
    type DgtImportExecutionResult,
    type DgtImportParseResult,
    type ParsedDgtImportData,
    type AppData,
    type BackupValidation,
    type TodoistImportExecutionResult,
    type TodoistImportParseResult,
    type ParsedTodoistProject,
    validateBackupJson,
    useTaskStore,
} from '@mindwtr/core';

import { logError, logInfo } from './app-log';
import { mobileStorage } from './storage-adapter';

const StorageAccessFramework = FileSystem.StorageAccessFramework;
const SNAPSHOT_DIR_NAME = 'snapshots';
const SNAPSHOT_FILE_PATTERN = /^data\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.snapshot\.json$/u;
const MAX_LOCAL_SNAPSHOTS = 5;

export type TransferDocument = {
    fileName: string;
    lastModified?: number | null;
    uri: string;
};

type SnapshotApplyResult = {
    snapshotName: string;
};

const countActiveRecords = (data: AppData) => ({
    tasks: data.tasks.filter((task) => !task.deletedAt).length,
    projects: data.projects.filter((project) => !project.deletedAt).length,
    sections: data.sections.filter((section) => !section.deletedAt).length,
    areas: data.areas.filter((area) => !area.deletedAt).length,
});

const toCountExtra = (data: AppData): Record<string, string> => {
    const counts = countActiveRecords(data);
    return {
        tasks: String(counts.tasks),
        projects: String(counts.projects),
        sections: String(counts.sections),
        areas: String(counts.areas),
    };
};

const normalizeBaseUri = (value?: string | null): string | null => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
};

const getSnapshotDirectory = (): Directory | null => {
    const baseUri = normalizeBaseUri(Paths.document?.uri ?? FileSystem.documentDirectory);
    if (!baseUri) return null;
    return new Directory(`${baseUri}/${SNAPSHOT_DIR_NAME}`);
};

const buildSnapshotFileName = (date: Date = new Date()): string => {
    const iso = date.toISOString();
    const [datePart, timePartWithMs] = iso.split('T');
    const [timePart] = (timePartWithMs || '').split('.');
    const safeTime = String(timePart || '00:00:00').replace(/:/gu, '-');
    return `data.${datePart}T${safeTime}.snapshot.json`;
};

const listSnapshotEntries = (directory: Directory): Array<{ name: string; uri: string }> => {
    if (!directory.exists) return [];
    return directory
        .list()
        .map((entry) => {
            const uri = String(entry.uri || '');
            const name = uri.split('/').pop() || '';
            return { name, uri };
        })
        .filter((entry) => SNAPSHOT_FILE_PATTERN.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name));
};

const pruneSnapshots = (directory: Directory): void => {
    const entries = listSnapshotEntries(directory);
    entries.slice(MAX_LOCAL_SNAPSHOTS).forEach((entry) => {
        try {
            const file = new File(entry.uri);
            if (file.exists) {
                file.delete();
            }
        } catch {
            // Ignore best-effort cleanup failures.
        }
    });
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
    };
};

const saveCurrentDataSnapshot = async (data: AppData): Promise<string> => {
    void logInfo('Recovery snapshot started', {
        scope: 'transfer',
        extra: {
            operation: 'snapshot',
            source: 'local',
        },
    });
    const directory = getSnapshotDirectory();
    if (!directory) {
        throw new Error('Snapshot storage is unavailable on this device.');
    }
    directory.create({ intermediates: true, idempotent: true });
    const fileName = buildSnapshotFileName();
    const file = new File(`${directory.uri}/${fileName}`);
    if (file.exists) {
        file.delete();
    }
    file.create({ intermediates: true, overwrite: true });
    file.write(serializeBackupData(data));
    pruneSnapshots(directory);
    void logInfo('Recovery snapshot complete', {
        scope: 'transfer',
        extra: {
            operation: 'snapshot',
            source: 'local',
            ...toCountExtra(data),
        },
    });
    return fileName;
};

const applyImportedData = async (data: AppData): Promise<void> => {
    await mobileStorage.saveData(data);
    await useTaskStore.getState().fetchData({ silent: true });
};

export const pickBackupDocument = async (): Promise<TransferDocument | null> =>
    pickDocument('application/json');

export const pickTodoistDocument = async (): Promise<TransferDocument | null> =>
    pickDocument([
        'text/csv',
        'text/comma-separated-values',
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream',
    ]);

export const pickDgtDocument = async (): Promise<TransferDocument | null> =>
    pickDocument([
        'application/json',
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream',
    ]);

export const pickOmniFocusDocument = async (): Promise<TransferDocument | null> =>
    pickDocument([
        'text/csv',
        'text/comma-separated-values',
        'application/json',
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream',
    ]);

export const inspectBackupDocument = async (
    document: TransferDocument,
    options?: { appVersion?: string | null }
): Promise<BackupValidation> => {
    const rawJson = await readTextFile(document.uri);
    return validateBackupJson(rawJson, {
        appVersion: options?.appVersion,
        fileModifiedAt: document.lastModified,
        fileName: document.fileName,
    });
};

export const inspectTodoistDocument = async (
    document: TransferDocument
): Promise<TodoistImportParseResult> => {
    const bytes = await readBinaryFile(document.uri);
    return parseTodoistImportSource({
        bytes,
        fileName: document.fileName,
    });
};

export const inspectDgtDocument = async (
    document: TransferDocument
): Promise<DgtImportParseResult> => {
    const bytes = await readBinaryFile(document.uri);
    return parseDgtImportSource({
        bytes,
        fileName: document.fileName,
    });
};

export const inspectOmniFocusDocument = async (
    document: TransferDocument
): Promise<OmniFocusImportParseResult> => {
    const bytes = await readBinaryFile(document.uri);
    return parseOmniFocusImportSource({
        bytes,
        fileName: document.fileName,
    });
};

export const restoreDataFromBackup = async (backupData: AppData): Promise<SnapshotApplyResult> => {
    addBreadcrumb('transfer:restore');
    void logInfo('Backup restore started', {
        scope: 'transfer',
        extra: {
            operation: 'restoreBackup',
            source: 'backup',
        },
    });
    try {
        await flushPendingSave();
        const currentData = await mobileStorage.getData();
        const snapshotName = await saveCurrentDataSnapshot(currentData);
        await applyImportedData(backupData);
        void logInfo('Backup restore complete', {
            scope: 'transfer',
            extra: {
                operation: 'restoreBackup',
                source: 'backup',
                ...toCountExtra(backupData),
            },
        });
        return { snapshotName };
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'restoreBackup' } });
        throw error;
    }
};

export const importTodoistData = async (
    parsedProjects: ParsedTodoistProject[]
): Promise<SnapshotApplyResult & { result: TodoistImportExecutionResult }> => {
    addBreadcrumb('transfer:restore');
    void logInfo('Todoist import started', {
        scope: 'transfer',
        extra: {
            operation: 'importTodoist',
            source: 'todoist',
        },
    });
    try {
        await flushPendingSave();
        const currentData = await mobileStorage.getData();
        const snapshotName = await saveCurrentDataSnapshot(currentData);
        const result = applyTodoistImport(currentData, parsedProjects);
        await applyImportedData(result.data);
        void logInfo('Todoist import complete', {
            scope: 'transfer',
            extra: {
                operation: 'importTodoist',
                source: 'todoist',
                tasks: String(result.importedTaskCount),
                projects: String(result.importedProjectCount),
                sections: String(result.importedSectionCount),
                checklistItems: String(result.importedChecklistItemCount),
            },
        });
        return {
            snapshotName,
            result,
        };
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'importTodoist' } });
        throw error;
    }
};

export const importDgtData = async (
    parsedData: ParsedDgtImportData
): Promise<SnapshotApplyResult & { result: DgtImportExecutionResult }> => {
    addBreadcrumb('transfer:restore');
    void logInfo('DGT import started', {
        scope: 'transfer',
        extra: {
            operation: 'importDgt',
            source: 'dgt',
        },
    });
    try {
        await flushPendingSave();
        const currentData = await mobileStorage.getData();
        const snapshotName = await saveCurrentDataSnapshot(currentData);
        const result = applyDgtImport(currentData, parsedData);
        await applyImportedData(result.data);
        void logInfo('DGT import complete', {
            scope: 'transfer',
            extra: {
                operation: 'importDgt',
                source: 'dgt',
                tasks: String(result.importedTaskCount),
                projects: String(result.importedProjectCount),
                areas: String(result.importedAreaCount),
                checklistItems: String(result.importedChecklistItemCount),
            },
        });
        return {
            snapshotName,
            result,
        };
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'importDgt' } });
        throw error;
    }
};

export const importOmniFocusData = async (
    parsedData: ParsedOmniFocusImportData
): Promise<SnapshotApplyResult & { result: OmniFocusImportExecutionResult }> => {
    addBreadcrumb('transfer:restore');
    void logInfo('OmniFocus import started', {
        scope: 'transfer',
        extra: {
            operation: 'importOmniFocus',
            source: 'omnifocus',
        },
    });
    try {
        await flushPendingSave();
        const currentData = await mobileStorage.getData();
        const snapshotName = await saveCurrentDataSnapshot(currentData);
        const result = applyOmniFocusImport(currentData, parsedData);
        await applyImportedData(result.data);
        void logInfo('OmniFocus import complete', {
            scope: 'transfer',
            extra: {
                operation: 'importOmniFocus',
                source: 'omnifocus',
                areas: String(result.importedAreaCount),
                checklistItems: String(result.importedChecklistItemCount),
                tasks: String(result.importedTaskCount),
                projects: String(result.importedProjectCount),
                standaloneTasks: String(result.importedStandaloneTaskCount),
            },
        });
        return {
            snapshotName,
            result,
        };
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'importOmniFocus' } });
        throw error;
    }
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
        await flushPendingSave();
        await applyImportedData(validation.data);
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

export const exportCurrentDataBackup = async (data: AppData): Promise<void> => {
    addBreadcrumb('transfer:export');
    const snapshotName = createBackupFileName();
    const jsonContent = serializeBackupData(data);
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
                        'application/json'
                    );
                    await StorageAccessFramework.writeAsStringAsync(fileUri, jsonContent);
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
        await FileSystem.writeAsStringAsync(fileUri, jsonContent);
        const Sharing = await import('expo-sharing');
        if (!(await Sharing.isAvailableAsync())) {
            throw new Error('Sharing is not available on this device.');
        }
        await Sharing.shareAsync(fileUri, {
            UTI: 'public.json',
            mimeType: 'application/json',
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
