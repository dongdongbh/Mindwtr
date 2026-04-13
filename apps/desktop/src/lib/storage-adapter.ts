import { AppData, SQLITE_SCHEMA_VERSION, StorageAdapter, TaskQueryOptions } from '@mindwtr/core';
import { invoke } from '@tauri-apps/api/core';
import { logInfo, logWarn } from './app-log';
import { reportError } from './report-error';
import { markLocalWrite } from './local-data-watcher';

const STORAGE_SCHEMA_VERSION_KEY = 'mindwtr-storage-schema-version';
let storageInitLogged = false;

const invokeWithError = async <T>(
    action: string,
    command: string,
    args?: Record<string, unknown>
): Promise<T> => {
    try {
        return await invoke<T>(command as any, args as any);
    } catch (error) {
        reportError(`Failed to ${action}`, error, { category: 'storage', scope: 'storage' });
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to ${action}: ${detail}`);
    }
};

const logStorageInitIfNeeded = () => {
    if (storageInitLogged) return;
    storageInitLogged = true;
    const schemaVersion = String(SQLITE_SCHEMA_VERSION);
    try {
        const previousSchemaVersion = localStorage.getItem(STORAGE_SCHEMA_VERSION_KEY);
        if (previousSchemaVersion && previousSchemaVersion !== schemaVersion) {
            void logInfo('Schema migration', {
                scope: 'storage',
                extra: { from: previousSchemaVersion, to: schemaVersion },
            });
        }
        localStorage.setItem(STORAGE_SCHEMA_VERSION_KEY, schemaVersion);
    } catch (error) {
        // Local schema-version bookkeeping is best-effort only.
        void error;
    }
    void logInfo('Storage init complete', {
        scope: 'storage',
        extra: {
            storageType: 'sqlite',
            schemaVersion,
        },
    });
};

export const tauriStorage: StorageAdapter = {
    getData: async (): Promise<AppData> => {
        try {
            const data = await invoke<AppData>('get_data' as any);
            logStorageInitIfNeeded();
            return data;
        } catch (error) {
            try {
                const data = await invoke<AppData>('read_data_json' as any);
                void logWarn('getData fallback triggered', {
                    scope: 'storage',
                    extra: {
                        fallback: 'data_json',
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
                logStorageInitIfNeeded();
                return data;
            } catch {
                reportError('getData failure', error, { category: 'storage', scope: 'storage' });
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to load data: ${detail}`);
            }
        }
    },
    saveData: async (data: AppData): Promise<void> => {
        markLocalWrite(data);
        try {
            await invoke<void>('save_data' as any, { data } as any);
            logStorageInitIfNeeded();
        } catch (error) {
            reportError('saveData failure', error, { category: 'storage', scope: 'storage' });
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to save data: ${detail}`);
        }
    },
    queryTasks: async (options: TaskQueryOptions) => {
        return invokeWithError('query tasks', 'query_tasks', { options });
    },
    searchAll: async (query: string) => {
        return invokeWithError('search', 'search_fts', { query });
    },
};
