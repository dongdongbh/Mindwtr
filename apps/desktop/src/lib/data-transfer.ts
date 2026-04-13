import {
    addBreadcrumb,
    applyTodoistImport,
    createBackupFileName,
    flushPendingSave,
    parseTodoistImportSource,
    serializeBackupData,
    validateBackupJson,
    type AppData,
    type BackupValidation,
    type ParsedTodoistProject,
    type TodoistImportExecutionResult,
    type TodoistImportParseResult,
    useTaskStore,
} from '@mindwtr/core';

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

const getStorage = () => (isTauriRuntime() ? tauriStorage : webStorage);

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

const downloadTextFile = async (fileName: string, text: string): Promise<void> => {
    if (isTauriRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const selected = await save({
            defaultPath: fileName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
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

    const blob = new Blob([text], { type: 'application/json' });
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

const persistTransferredData = async (data: AppData): Promise<void> => {
    await getStorage().saveData(data);
    await useTaskStore.getState().fetchData({ silent: true });
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

export const inspectDesktopBackup = async (appVersion?: string | null): Promise<BackupValidation | null> => {
    const document = await pickTransferDocument({
        accept: '.json,application/json',
        extensions: ['json'],
        mode: 'text',
        title: 'Mindwtr Backup',
    });
    if (!document?.text) return null;
    return validateBackupJson(document.text, {
        appVersion,
        fileModifiedAt: document.lastModified,
        fileName: document.fileName,
    });
};

export const inspectDesktopTodoistImport = async (): Promise<TodoistImportParseResult | null> => {
    const document = await pickTransferDocument({
        accept: '.csv,.zip,text/csv,application/zip',
        extensions: ['csv', 'zip'],
        mode: 'binary',
        title: 'Todoist Export',
    });
    if (!document) return null;
    return parseTodoistImportSource({
        bytes: document.bytes,
        fileName: document.fileName,
    });
};

export const restoreDesktopBackup = async (data: AppData): Promise<DesktopTransferResult> => {
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
        const snapshotName = isTauriRuntime() ? await SyncService.createDataSnapshot() : null;
        await persistTransferredData(data);
        void logInfo('Backup restore complete', {
            scope: 'transfer',
            extra: {
                operation: 'restoreBackup',
                source: 'backup',
                ...toCountExtra(data),
            },
        });
        return { snapshotName };
    } catch (error) {
        void logError(error, { scope: 'transfer', extra: { operation: 'restoreBackup' } });
        throw error;
    }
};

export const importDesktopTodoistData = async (
    parsedProjects: ParsedTodoistProject[]
): Promise<DesktopTransferResult & { result: TodoistImportExecutionResult }> => {
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
        const currentData = await getStorage().getData();
        const snapshotName = isTauriRuntime() ? await SyncService.createDataSnapshot() : null;
        const result = applyTodoistImport(currentData, parsedProjects);
        await persistTransferredData(result.data);
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
