import { AppData, SqliteAdapter, searchAll, type SqliteClient, StorageAdapter } from '@mindwtr/core';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { WIDGET_DATA_KEY } from './widget-data';
import { updateAndroidWidgetFromData } from './widget-service';
import { logError, logWarn } from './app-log';
import { markStartupPhase, measureStartupPhase } from './startup-profiler';

const DATA_KEY = WIDGET_DATA_KEY;
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];
const EMPTY_APP_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
const SQLITE_STARTUP_TIMEOUT_MS = 3_500;
const SQLITE_QUERY_TIMEOUT_MS = 2_500;
const SQLITE_RETRY_COOLDOWN_MS = 60_000;

let saveQueue: Promise<void> = Promise.resolve();

const enqueueSave = async (work: () => Promise<void>): Promise<void> => {
    const next = saveQueue.then(work, () => work());
    saveQueue = next.catch(() => undefined);
    return next;
};
const SQLITE_DB_NAME = 'mindwtr.db';
const PREFER_LEGACY_SQLITE_OPEN = true;
const sqliteSyncOpenEnv = String(process.env.EXPO_PUBLIC_SQLITE_SYNC_OPEN || '').trim().toLowerCase();
const ENABLE_SYNC_SQLITE_OPEN = sqliteSyncOpenEnv === '1' || sqliteSyncOpenEnv === 'true';

type SqliteState = {
    adapter: SqliteAdapter;
    client: SqliteClient;
};

let sqliteStatePromise: Promise<SqliteState> | null = null;
let preferJsonBackup = false;
let preferJsonBackupUntil = 0;
let didWarnPreferJsonBackup = false;

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const buildStorageExtra = (message?: string, error?: unknown): Record<string, string> | undefined => {
    const extra: Record<string, string> = {};
    if (message) extra.message = message;
    if (error) {
        extra.error = formatError(error);
        if (error instanceof Error && error.stack) {
            extra.stack = error.stack;
        }
    }
    return Object.keys(extra).length ? extra : undefined;
};

const logStorageWarn = (message: string, error?: unknown) => {
    void logWarn(message, { scope: 'storage', extra: buildStorageExtra(undefined, error) });
};

const logStorageError = (message: string, error?: unknown) => {
    const err = error instanceof Error ? error : new Error(message);
    void logError(err, { scope: 'storage', extra: buildStorageExtra(message, error) });
};

const warnPreferJsonBackup = () => {
    if (didWarnPreferJsonBackup) return;
    logStorageWarn('[Storage] SQLite unavailable; using JSON backup for reads until restart.');
    didWarnPreferJsonBackup = true;
};

const withOperationTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
};

const shouldUseJsonBackupFastPath = () => preferJsonBackup && Date.now() < preferJsonBackupUntil;

const markPreferJsonBackup = () => {
    preferJsonBackup = true;
    preferJsonBackupUntil = Date.now() + SQLITE_RETRY_COOLDOWN_MS;
    warnPreferJsonBackup();
};

const clearPreferJsonBackup = () => {
    preferJsonBackup = false;
    preferJsonBackupUntil = 0;
    didWarnPreferJsonBackup = false;
};

const createLegacyClient = (db: any): SqliteClient => {
    const execSql = (sql: string, params: unknown[] = []) =>
        new Promise<any>((resolve, reject) => {
            db.transaction(
                (tx: any) => {
                    tx.executeSql(
                        sql,
                        params,
                        (_: any, result: any) => resolve(result),
                        (_: any, error: any) => {
                            reject(error);
                            return true;
                        }
                    );
                },
                (error: any) => reject(error)
            );
        });

    const exec = async (sql: string) => {
        const statements = sql
            .split(';')
            .map((statement) => statement.trim())
            .filter(Boolean);
        for (const statement of statements) {
            await execSql(statement);
        }
    };

    return {
        run: async (sql: string, params: unknown[] = []) => {
            await execSql(sql, params);
        },
        all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            const rows = result?.rows;
            if (!rows) return [] as T[];
            if (Array.isArray(rows._array)) return rows._array as T[];
            const collected: T[] = [];
            for (let i = 0; i < rows.length; i += 1) {
                collected.push(rows.item(i));
            }
            return collected;
        },
        get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            const rows = result?.rows;
            if (!rows || rows.length === 0) return undefined;
            if (Array.isArray(rows._array)) return rows._array[0] as T;
            return rows.item(0) as T;
        },
        exec,
    };
};

const createSqliteClient = async (): Promise<SqliteClient> => {
    markStartupPhase('mobile.storage.sqlite_client.create:start');
    // Use require to avoid async bundle loading in dev client.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SQLite = require('expo-sqlite');
    if (PREFER_LEGACY_SQLITE_OPEN && typeof (SQLite as any).openDatabase === 'function') {
        const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
        markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'legacy_preferred' });
        return createLegacyClient(legacyDb);
    }
    const openDatabaseSync = (SQLite as any).openDatabaseSync as ((name: string) => any) | undefined;
    if (ENABLE_SYNC_SQLITE_OPEN && openDatabaseSync) {
        try {
            const db = openDatabaseSync(SQLITE_DB_NAME);
            if (db?.runAsync && db?.getAllAsync && db?.getFirstAsync && db?.execAsync) {
                markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'sync' });
                return {
                    run: async (sql: string, params: unknown[] = []) => {
                        await db.runAsync(sql, params);
                    },
                    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        db.getAllAsync(sql, params) as Promise<T[]>,
                    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        (await db.getFirstAsync(sql, params)) as T | undefined,
                    exec: async (sql: string) => {
                        await db.execAsync(sql);
                    },
                };
            }
        } catch (error) {
            if (__DEV__) {
                logStorageWarn('[Storage] Sync SQLite open failed; falling back', error);
            }
        }
    }
    const openDatabaseAsync = (SQLite as any).openDatabaseAsync as ((name: string) => Promise<any>) | undefined;
    if (openDatabaseAsync) {
        try {
            const db = await openDatabaseAsync(SQLITE_DB_NAME);
            if (db?.runAsync && db?.getAllAsync && db?.getFirstAsync && db?.execAsync) {
                markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'async' });
                return {
                    run: async (sql: string, params: unknown[] = []) => {
                        await db.runAsync(sql, params);
                    },
                    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        db.getAllAsync(sql, params) as Promise<T[]>,
                    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        (await db.getFirstAsync(sql, params)) as T | undefined,
                    exec: async (sql: string) => {
                        await db.execAsync(sql);
                    },
                };
            }
        } catch (error) {
            if (__DEV__) {
                logStorageWarn('[Storage] Async SQLite open failed, falling back to legacy API', error);
            }
        }
    }

    const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
    markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'legacy' });
    return createLegacyClient(legacyDb);
};

const sqliteHasAnyData = async (client: SqliteClient): Promise<boolean> => {
    const count = async (table: string) => {
        const row = await client.get<{ count?: number }>(`SELECT COUNT(*) as count FROM ${table}`);
        return Number(row?.count ?? 0);
    };
    const [tasks, projects, areas, settings] = await Promise.all([
        count('tasks'),
        count('projects'),
        count('areas'),
        count('settings'),
    ]);
    return tasks > 0 || projects > 0 || areas > 0 || settings > 0;
};

const getLegacyJson = async (AsyncStorage: any): Promise<string | null> => {
    let jsonValue = await AsyncStorage.getItem(DATA_KEY);
    if (jsonValue != null) return jsonValue;
    for (const legacyKey of LEGACY_DATA_KEYS) {
        const legacyValue = await AsyncStorage.getItem(legacyKey);
        if (legacyValue != null) {
            await AsyncStorage.setItem(DATA_KEY, legacyValue);
            return legacyValue;
        }
    }
    return null;
};

const initSqliteState = async (): Promise<SqliteState> => {
    markStartupPhase('mobile.storage.sqlite_init.start');
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    let client = await measureStartupPhase('mobile.storage.sqlite_init.create_client', async () => createSqliteClient());
    let adapter = new SqliteAdapter(client);
    try {
        await measureStartupPhase('mobile.storage.sqlite_init.ensure_schema', async () => adapter.ensureSchema());
    } catch (error) {
        if (__DEV__) {
            logStorageWarn('[Storage] SQLite schema init failed, retrying with legacy API', error);
        }
        // Use require to avoid async bundle loading in dev client.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const SQLite = require('expo-sqlite');
        const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
        client = createLegacyClient(legacyDb);
        adapter = new SqliteAdapter(client);
        await measureStartupPhase('mobile.storage.sqlite_init.ensure_schema_legacy_retry', async () => adapter.ensureSchema());
    }
    let hasData = false;
    try {
        hasData = await measureStartupPhase('mobile.storage.sqlite_init.has_any_data', async () => sqliteHasAnyData(client));
    } catch (error) {
        if (__DEV__) {
            logStorageWarn('[Storage] SQLite availability check failed', error);
        }
        hasData = false;
    }
    if (!hasData) {
        const jsonValue = await measureStartupPhase('mobile.storage.sqlite_init.read_legacy_json', async () => getLegacyJson(AsyncStorage));
        if (jsonValue != null) {
            try {
                const data = JSON.parse(jsonValue) as AppData;
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                // Ensure JSON backup is updated before SQLite migration so fallback stays consistent.
                await measureStartupPhase('mobile.storage.sqlite_init.migrate_json_backup_set', async () =>
                    AsyncStorage.setItem(DATA_KEY, JSON.stringify(data))
                );
                await measureStartupPhase('mobile.storage.sqlite_init.migrate_json_to_sqlite', async () => adapter.saveData(data));
            } catch (error) {
                logStorageWarn('[Storage] Failed to migrate JSON data to SQLite', error);
            }
        }
    }
    markStartupPhase('mobile.storage.sqlite_init.end');
    return { adapter, client };
};

const getSqliteState = async (): Promise<SqliteState> => {
    if (!sqliteStatePromise) {
        markStartupPhase('mobile.storage.sqlite_state.cache_miss');
        sqliteStatePromise = initSqliteState();
    } else {
        markStartupPhase('mobile.storage.sqlite_state.cache_hit');
    }
    try {
        const state = await sqliteStatePromise;
        markStartupPhase('mobile.storage.sqlite_state.ready');
        return state;
    } catch (error) {
        markStartupPhase('mobile.storage.sqlite_state.retry_after_error');
        sqliteStatePromise = null;
        // Retry once on init failure to avoid a poisoned cache.
        sqliteStatePromise = initSqliteState();
        const state = await sqliteStatePromise;
        markStartupPhase('mobile.storage.sqlite_state.ready_after_retry');
        return state;
    }
};

// Platform-specific storage implementation
const createStorage = (): StorageAdapter => {
    // Web platform - use localStorage
    if (Platform.OS === 'web') {
        return {
            getData: async (): Promise<AppData> => {
                if (typeof window === 'undefined') {
                    return { tasks: [], projects: [], sections: [], areas: [], settings: {} };
                }
                let jsonValue = localStorage.getItem(DATA_KEY);
                if (jsonValue == null) {
                    for (const legacyKey of LEGACY_DATA_KEYS) {
                        const legacyValue = localStorage.getItem(legacyKey);
                        if (legacyValue != null) {
                            localStorage.setItem(DATA_KEY, legacyValue);
                            jsonValue = legacyValue;
                            break;
                        }
                    }
                }
                if (jsonValue == null) {
                    return { tasks: [], projects: [], sections: [], areas: [], settings: {} };
                }
                try {
                    const data = JSON.parse(jsonValue) as AppData;
                    data.areas = Array.isArray(data.areas) ? data.areas : [];
                    data.sections = Array.isArray(data.sections) ? data.sections : [];
                    return data;
                } catch (e) {
                    // JSON parse error - data corrupted, throw so user is notified
                    logStorageError('Failed to parse stored data - may be corrupted', e);
                    throw new Error('Data appears corrupted. Please restore from backup.');
                }
            },
            saveData: async (data: AppData): Promise<void> => {
                try {
                    if (typeof window !== 'undefined') {
                        const jsonValue = JSON.stringify(data);
                        localStorage.setItem(DATA_KEY, jsonValue);
                    }
                } catch (e) {
                    logStorageError('Failed to save data', e);
                    throw new Error('Failed to save data: ' + (e as Error).message);
                }
            },
        };
    }

    // Native platforms - use SQLite with AsyncStorage backup for widgets/rollback.
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const shouldUseSqlite = Constants.appOwnership !== 'expo';

    return {
        getData: async (): Promise<AppData> => {
            markStartupPhase('mobile.storage.get_data.start');
            const loadJsonBackup = async () => {
                const jsonValue = await getLegacyJson(AsyncStorage);
                if (jsonValue == null) {
                    return { ...EMPTY_APP_DATA };
                }
                if (jsonValue != null) {
                    try {
                        const data = JSON.parse(jsonValue) as AppData;
                        data.areas = Array.isArray(data.areas) ? data.areas : [];
                        updateAndroidWidgetFromData(data).catch((error) => {
                            logStorageWarn('[Widgets] Failed to update Android widget from backup', error);
                        });
                        return data;
                    } catch (parseError) {
                        logStorageError('Failed to parse stored data - may be corrupted', parseError);
                    }
                }
                throw new Error('Data appears corrupted. Please restore from backup.');
            };

            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                return loadJsonBackup();
            }
            if (preferJsonBackup && !shouldUseSqlite) {
                warnPreferJsonBackup();
                return loadJsonBackup();
            }
            if (preferJsonBackup) {
                warnPreferJsonBackup();
            }
            try {
                if (!shouldUseSqlite) {
                    throw new Error('SQLite disabled in Expo Go');
                }
                const { adapter } = await measureStartupPhase('mobile.storage.get_data.sqlite_get_state', async () =>
                    withOperationTimeout(
                        getSqliteState(),
                        SQLITE_STARTUP_TIMEOUT_MS,
                        'SQLite initialization timed out'
                    )
                );
                const data = await measureStartupPhase('mobile.storage.get_data.sqlite_read', async () =>
                    withOperationTimeout(
                        adapter.getData(),
                        SQLITE_STARTUP_TIMEOUT_MS,
                        'SQLite read timed out'
                    )
                );
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                updateAndroidWidgetFromData(data).catch((error) => {
                    logStorageWarn('[Widgets] Failed to update Android widget from storage load', error);
                });
                markStartupPhase('mobile.storage.get_data.widget_update_dispatched');
                clearPreferJsonBackup();
                markStartupPhase('mobile.storage.get_data.end');
                return data;
            } catch (e) {
                if (__DEV__ && !shouldUseSqlite && String(e).includes('Expo Go')) {
                    logStorageWarn('[Storage] SQLite disabled in Expo Go, falling back to JSON backup');
                } else {
                    logStorageWarn('[Storage] SQLite load failed, falling back to JSON backup', e);
                }
                markPreferJsonBackup();
                const fallbackData = await measureStartupPhase('mobile.storage.get_data.json_fallback_read', async () => loadJsonBackup());
                markStartupPhase('mobile.storage.get_data.end');
                return fallbackData;
            }
        },
        saveData: async (data: AppData): Promise<void> => {
            return enqueueSave(async () => {
                markStartupPhase('mobile.storage.save_data.start');
                try {
                    if (!shouldUseSqlite) {
                        throw new Error('SQLite disabled in Expo Go');
                    }
                    const { adapter } = await measureStartupPhase('mobile.storage.save_data.sqlite_get_state', async () => getSqliteState());
                    await measureStartupPhase('mobile.storage.save_data.sqlite_write', async () => adapter.saveData(data));
                    clearPreferJsonBackup();
                } catch (error) {
                    markPreferJsonBackup();
                    if (__DEV__ && !shouldUseSqlite && String(error).includes('Expo Go')) {
                        logStorageWarn('[Storage] SQLite disabled in Expo Go, keeping JSON backup');
                    } else {
                        logStorageWarn('[Storage] SQLite save failed, keeping JSON backup', error);
                    }
                }
                try {
                    const jsonValue = await measureStartupPhase('mobile.storage.save_data.json_stringify', async () => JSON.stringify(data));
                    await measureStartupPhase('mobile.storage.save_data.asyncstorage_set', async () =>
                        AsyncStorage.setItem(DATA_KEY, jsonValue)
                    );
                    await measureStartupPhase('mobile.storage.save_data.widget_update', async () => updateAndroidWidgetFromData(data));
                    markStartupPhase('mobile.storage.save_data.end');
                } catch (e) {
                    markStartupPhase('mobile.storage.save_data.error');
                    logStorageError('Failed to save data', e);
                    throw new Error('Failed to save data: ' + (e as Error).message);
                }
            });
        },
        queryTasks: async (options) => {
            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                const data = await mobileStorage.getData();
                const statusFilter = options.status;
                const excludeStatuses = options.excludeStatuses ?? [];
                const includeArchived = options.includeArchived === true;
                const includeDeleted = options.includeDeleted === true;
                return data.tasks.filter((task) => {
                    if (!includeDeleted && task.deletedAt) return false;
                    if (!includeArchived && task.status === 'archived') return false;
                    if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
                    if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
                    if (options.projectId && task.projectId !== options.projectId) return false;
                    return true;
                });
            }
            try {
                const { adapter } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite query initialization timed out'
                );
                if (typeof (adapter as any).queryTasks === 'function') {
                    return withOperationTimeout(
                        (adapter as any).queryTasks(options),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite query timed out'
                    );
                }
            } catch (error) {
                markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite query failed, falling back to in-memory filter', error);
            }
            const data = await mobileStorage.getData();
            const statusFilter = options.status;
            const excludeStatuses = options.excludeStatuses ?? [];
            const includeArchived = options.includeArchived === true;
            const includeDeleted = options.includeDeleted === true;
            return data.tasks.filter((task) => {
                if (!includeDeleted && task.deletedAt) return false;
                if (!includeArchived && task.status === 'archived') return false;
                if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
                if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
                if (options.projectId && task.projectId !== options.projectId) return false;
                return true;
            });
        },
        searchAll: async (query: string) => {
            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                const data = await mobileStorage.getData();
                return searchAll(data.tasks, data.projects, query);
            }
            try {
                const { adapter } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite search initialization timed out'
                );
                if (typeof (adapter as any).searchAll === 'function') {
                    return withOperationTimeout(
                        (adapter as any).searchAll(query),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite search timed out'
                    );
                }
            } catch (error) {
                markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite search failed, falling back to in-memory search', error);
            }
            const data = await mobileStorage.getData();
            return searchAll(data.tasks, data.projects, query);
        },
    };
};

export const mobileStorage = createStorage();
