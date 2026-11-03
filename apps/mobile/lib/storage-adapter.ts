import { AppData, countSqliteCopyRepairs, mergeLegacyJsonCopy, repairAppDataForSqlite, SqliteAdapter, searchAll, splitSqlStatements, taskMatchesQuery, type SqliteClient, type CalendarSyncEntry, StorageAdapter, type Task } from '@mindwtr/core';
import { AppState, NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { WIDGET_DATA_KEY } from './widget-data';
import { updateMobileWidgetFromData } from './widget-service';
import { logError, logInfo, logWarn } from './app-log';
import { markStartupPhase, measureStartupPhase } from './startup-profiler';

const DATA_KEY = WIDGET_DATA_KEY;
const STARTUP_BACKUP_VERSION_KEY = `${DATA_KEY}:startup-backup-version`;
const STARTUP_BACKUP_UPDATED_AT_KEY = `${DATA_KEY}:startup-backup-updated-at`;
const STARTUP_BACKUP_OUTGROWN_AT_KEY = `${DATA_KEY}:startup-backup-outgrown-at`;


const JSON_AHEAD_OF_SQLITE_KEY = `${DATA_KEY}:json-ahead-of-sqlite`;
const STARTUP_BACKUP_VERSION = '2';
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];
const EMPTY_APP_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
const SQLITE_STARTUP_TIMEOUT_MS = 3_500;


const SQLITE_NO_FALLBACK_READ_TIMEOUT_MS = 15_000;
const SQLITE_QUERY_TIMEOUT_MS = 2_500;
const SQLITE_RETRY_COOLDOWN_MS = 60_000;
const SQLITE_NATIVE_MODULE_UNAVAILABLE = 'Native SQLite module unavailable; rebuild or reinstall the app so op-sqlite is included';


const SQLITE_WRITE_WAIT_TIMEOUT_MS = 3_000;

const SQLITE_WRITE_WAIT_LOG_THRESHOLD_MS = 50;
const SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS = 300;

let saveQueue: Promise<void> = Promise.resolve();

const enqueueSave = async (work: () => Promise<void>): Promise<void> => {
    const next = saveQueue.then(work, () => work());
    saveQueue = next.catch(() => undefined);
    return next;
};

const waitForQueuedSqliteWrites = async (): Promise<void> => {
    while (true) {
        const pendingSave = saveQueue;
        await pendingSave.catch(() => undefined);
        if (pendingSave === saveQueue) return;
    }
};

const SQLITE_DB_NAME = 'mindwtr.db';


const SQLITE_DIRECTORY_NAME = 'SQLite';

type SqliteState = {
    adapter: SqliteAdapter;
    client: SqliteClient;
    writeBlockedReason?: 'json-ahead-recovery-read' | 'json-migration-failed';

    jsonCopy?: string;
};

let sqliteStatePromise: Promise<SqliteState> | null = null;
let sqliteStateRetryAfter = 0;
let canonicalReloadRequired = false;
let canonicalReloadCandidates = new WeakSet<AppData>();
let sqliteOpenMode = 'unknown';
let sqliteDbPath: string | null = null;
let sqliteJournalDiagnostics: Record<string, string> | null = null;
let preferJsonBackup = false;
let preferJsonBackupUntil = 0;
let didWarnPreferJsonBackup = false;
let latestQueuedWriteStartedAtMs = 0;

const markQueuedWriteStarted = (): number => {
    const startedAtMs = Math.max(Date.now(), latestQueuedWriteStartedAtMs + 1);
    latestQueuedWriteStartedAtMs = startedAtMs;
    return startedAtMs;
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

class JsonAheadRecoveryReadError extends Error {
    constructor(readError: unknown) {
        super(formatError(readError));
        this.name = 'JsonAheadRecoveryReadError';
    }
}


class JsonMigrationFailedError extends Error {
    constructor(readonly jsonCopy: string, cause: unknown) {
        super(formatError(cause));
        this.name = 'JsonMigrationFailedError';
    }
}

const SQLITE_WRITE_BLOCKED_MESSAGES: Record<NonNullable<SqliteState['writeBlockedReason']> | 'canonical-reload', string> = {
    'canonical-reload': 'Pending local changes were recovered. Reload Mindwtr before saving again.',
    'json-ahead-recovery-read': 'Saving is temporarily disabled while Mindwtr retries recovery of pending local changes.',
    'json-migration-failed': 'Saving is blocked because moving your data into the database failed. Mindwtr tries again every minute. If this keeps happening, use Export Backup in Settings to keep a copy, then contact support.',
};

class SqliteWriteBlockedError extends Error {
    constructor(reason: keyof typeof SQLITE_WRITE_BLOCKED_MESSAGES) {
        super(SQLITE_WRITE_BLOCKED_MESSAGES[reason]);
        this.name = 'SqliteWriteBlockedError';
    }
}

const requireCanonicalReload = (): void => {
    canonicalReloadRequired = true;
    canonicalReloadCandidates = new WeakSet<AppData>();
};

const assertSqliteWritesAllowed = (state: SqliteState, reloadRequiredWhenEnqueued: boolean): void => {
    if (state.writeBlockedReason) {
        throw new SqliteWriteBlockedError(state.writeBlockedReason);
    }
    if (reloadRequiredWhenEnqueued || canonicalReloadRequired) {


        throw new SqliteWriteBlockedError('canonical-reload');
    }
};

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

const logStorageWarn = (message: string, error?: unknown, extra?: Record<string, string>) => {
    void logWarn(message, { scope: 'storage', extra: { ...buildStorageExtra(undefined, error), ...extra } });
};


const logStorageInfo = (message: string, extra?: Record<string, string>) => {
    void logInfo(message, { scope: 'storage', extra });
};

const logStorageError = (message: string, error?: unknown) => {
    const err = error instanceof Error ? error : new Error(message);
    void logError(err, { scope: 'storage', extra: buildStorageExtra(message, error) });
};

const warnPreferJsonBackup = () => {
    if (didWarnPreferJsonBackup) return;
    logStorageWarn('[Storage] SQLite unavailable; using JSON backup for reads until SQLite recovers.');
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


const awaitQueuedSqliteWrites = async (phase: string, timeoutMs = SQLITE_WRITE_WAIT_TIMEOUT_MS): Promise<void> => {
    const startedAt = Date.now();
    try {
        await withOperationTimeout(
            waitForQueuedSqliteWrites(),
            timeoutMs,
            `Timed out waiting for queued SQLite writes before ${phase}`
        );
    } catch (error) {
        logStorageWarn('[Storage] Gave up waiting for queued SQLite writes; falling back', error, {
            phase,
            waitedMs: String(Date.now() - startedAt),
        });
        throw error;
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= SQLITE_WRITE_WAIT_LOG_THRESHOLD_MS) {
        logStorageInfo('[Storage] Read waited for queued SQLite writes', {
            phase,
            waitedMs: String(waitedMs),
            ...(sqliteJournalDiagnostics ?? {}),
        });
    }
};

const shouldUseJsonBackupFastPath = () => preferJsonBackup && isJsonCopyServable() && Date.now() < preferJsonBackupUntil;


let jsonAheadOfSqlite = false;

const markJsonAheadOfSqlite = async (): Promise<void> => {
    if (jsonAheadOfSqlite) return;
    try {
        await AsyncStorage.setItem(JSON_AHEAD_OF_SQLITE_KEY, '1');
        jsonAheadOfSqlite = true;
    } catch (error) {
        logStorageWarn('[Storage] Failed to mark the JSON backup as ahead of SQLite', error);
        throw error;
    }
};

const removeJsonAheadMarker = async (): Promise<void> => {
    try {
        await AsyncStorage.removeItem(JSON_AHEAD_OF_SQLITE_KEY);
    } catch (error) {
        logStorageWarn('[Storage] Failed to clear the JSON-ahead marker', error);
    }
};

const clearJsonAheadOfSqlite = async (): Promise<void> => {
    if (!jsonAheadOfSqlite) return;
    jsonAheadOfSqlite = false;
    await removeJsonAheadMarker();
};

const readJsonAheadOfSqlite = async (): Promise<boolean> => {
    try {
        jsonAheadOfSqlite = await AsyncStorage.getItem(JSON_AHEAD_OF_SQLITE_KEY) != null;
    } catch (error) {
        jsonAheadOfSqlite = true;
        logStorageWarn('[Storage] Failed to read the JSON-ahead marker', error);
        throw new JsonAheadRecoveryReadError(error);
    }
    return jsonAheadOfSqlite;
};

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

const createOpSqliteClient = (db: any): SqliteClient => {
    const execSql = (sql: string, params: unknown[] = []) => {


        const args = params.map((value) => (value === undefined ? null : value));
        return db.execute(sql, args);
    };


    const exec = async (sql: string) => {
        for (const statement of splitSqlStatements(sql)) {
            await execSql(statement);
        }
    };

    return {
        run: async (sql: string, params: unknown[] = []) => {
            await execSql(sql, params);
        },
        all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            return (result?.rows ?? []) as T[];
        },
        get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            const rows = result?.rows;
            if (!rows || rows.length === 0) return undefined;
            return rows[0] as T;
        },
        exec,
    };
};

const stripFileUriScheme = (uri: string) => uri.replace(/^file:\/\//, '');

const resolveSqliteDirectoryUri = (): string | null => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const FileSystem = require('expo-file-system');
        const documentUri: string | undefined = FileSystem?.Paths?.document?.uri;
        if (documentUri) {
            return `${documentUri.replace(/\/+$/, '')}/${SQLITE_DIRECTORY_NAME}`;
        }
    } catch {

    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const LegacyFileSystem = require('expo-file-system/legacy');
        const documentDirectory: string | null | undefined = LegacyFileSystem?.documentDirectory;
        if (documentDirectory) {
            return `${documentDirectory.replace(/\/+$/, '')}/${SQLITE_DIRECTORY_NAME}`;
        }
    } catch {

    }
    return null;
};


const ensureSqliteDirectoryExists = (directoryUri: string): void => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const FileSystem = require('expo-file-system');
        if (typeof FileSystem?.Directory === 'function') {
            const directory = new FileSystem.Directory(directoryUri);
            if (!directory.exists) {
                directory.create({ intermediates: true });
            }
        }
    } catch (error) {
        logStorageWarn('[Storage] Failed to ensure SQLite directory exists', error, { directoryUri });
    }
};

const getSqliteUnavailableReason = (): string | null => {
    if (Constants.appOwnership === 'expo') {
        return 'SQLite disabled in Expo Go';
    }
    const hasInstalledProxy = Boolean(
        (globalThis as typeof globalThis & { __OPSQLiteProxy?: object }).__OPSQLiteProxy
    );
    if (!hasInstalledProxy && NativeModules.OPSQLite == null) {
        return SQLITE_NATIVE_MODULE_UNAVAILABLE;
    }
    return null;
};

const createSqliteClient = async (): Promise<SqliteClient> => {
    markStartupPhase('mobile.storage.sqlite_client.create:start');
    const unavailableReason = getSqliteUnavailableReason();
    if (unavailableReason) {
        throw new Error(unavailableReason);
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { open } = require('@op-engineering/op-sqlite');
    const directoryUri = resolveSqliteDirectoryUri();
    if (!directoryUri) {


        throw new Error('Could not resolve the SQLite directory');
    }
    ensureSqliteDirectoryExists(directoryUri);
    const db = open({ name: SQLITE_DB_NAME, location: stripFileUriScheme(directoryUri) });
    sqliteDbPath = typeof db.getDbPath === 'function' ? String(db.getDbPath()) : null;
    sqliteOpenMode = 'op-sqlite';
    markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'op-sqlite' });
    return createOpSqliteClient(db);
};

const sqliteHasAnyData = async (client: SqliteClient): Promise<boolean> => {
    const count = async (table: string) => {
        const row = await client.get<{ count?: number }>(`SELECT COUNT(*) as count FROM ${table}`);
        return Number(row?.count ?? 0);
    };
    const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'saved_filters', 'settings'];
    const counts = await Promise.all(tables.map((table) => count(table)));
    return counts.some((value) => value > 0);
};

const getLegacyJson = async (AsyncStorage: any): Promise<string | null> => {
    let jsonValue = await AsyncStorage.getItem(DATA_KEY);
    if (jsonValue != null) return jsonValue;
    for (const legacyKey of LEGACY_DATA_KEYS) {
        const legacyValue = await AsyncStorage.getItem(legacyKey);
        if (legacyValue != null) {
            try {
                await AsyncStorage.setItem(DATA_KEY, legacyValue);
            } catch (error) {

                logStorageWarn('[Storage] Failed to promote the legacy JSON copy', error);
            }
            return legacyValue;
        }
    }
    return null;
};

const normalizeStoredAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    people: Array.isArray(data.people) ? data.people : [],
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
});

const parseStoredAppDataJson = (jsonValue: string): AppData => (
    normalizeStoredAppData(JSON.parse(jsonValue) as AppData)
);


const JSON_BACKUP_MAX_CHARS = Platform.OS === 'android' ? 1_500_000 : Number.POSITIVE_INFINITY;
let jsonBackupSkippedOversize = false;


let jsonBackupOversizeAtMs = 0;
let jsonBackupOversizeChars = 0;

const isJsonBackupUsable = (): boolean => !jsonBackupSkippedOversize;


let jsonBackupFrozen = false;


let jsonCopyUnsafe = false;


const isJsonCopyServable = (): boolean => !jsonBackupFrozen && !jsonCopyUnsafe;


const assertJsonBackupNotFrozen = (cause: unknown): void => {
    if (!jsonBackupFrozen) return;
    logStorageWarn('[Storage] SQLite save failed while the JSON backup is frozen', cause);
    throw new Error('SQLite could not save this change, and the JSON backup holds data not yet merged into it.');
};


let jsonBackupStored: boolean | null = null;
let jsonBackupOutgrown: boolean | null = null;

const readJsonBackupOutgrown = async (): Promise<boolean> => {
    if (jsonBackupOutgrown === null) {
        jsonBackupOutgrown = await AsyncStorage.getItem(STARTUP_BACKUP_OUTGROWN_AT_KEY) != null;
    }
    return jsonBackupOutgrown;
};


const markJsonBackupOutgrown = async (): Promise<void> => {
    if (jsonBackupOutgrown === true || jsonAheadOfSqlite) return;
    try {
        await AsyncStorage.setItem(STARTUP_BACKUP_OUTGROWN_AT_KEY, String(Date.now()));
        jsonBackupOutgrown = true;
        jsonBackupStored = false;
    } catch (error) {
        logStorageWarn('[Storage] Failed to mark the JSON backup as outgrown', error);
    }
};

const hasStoredJsonBackup = async (): Promise<boolean> => {
    if (jsonBackupStored !== null) return jsonBackupStored;
    try {
        jsonBackupStored = await readStartupJsonBackupUpdatedAt(AsyncStorage) !== null
            && !await readJsonBackupOutgrown();
    } catch {
        return false;
    }
    if (!jsonBackupStored) {


        void logWarn('[Storage] No JSON backup stored; SQLite is the only readable copy', {
            scope: 'storage',
            force: true,
            extra: { releaseCheck: 'v1.3.8/rn-load-no-backup' },
        });
    }
    return jsonBackupStored;
};


let jsonCopyReconciled = false;
let didLogUnreconciledJsonCopy = false;


const hasReconciledJsonCopy = async (): Promise<boolean> => {
    if (jsonCopyReconciled) return true;
    try {
        if (await AsyncStorage.getItem(SQLITE_JSON_RECONCILE_KEY) != null) jsonCopyReconciled = true;
    } catch {

    }

    if (jsonCopyReconciled) return true;
    if (!didLogUnreconciledJsonCopy) {
        didLogUnreconciledJsonCopy = true;

        void logWarn('[Storage] JSON copy not yet merged into SQLite; reads wait for SQLite', {
            scope: 'storage',
            force: true,
            extra: { releaseCheck: 'v1.3.8/rn-unreconciled-no-fallback' },
        });
    }
    return false;
};


const hasUsableJsonBackup = async (): Promise<boolean> => (
    isJsonCopyServable()
    && isJsonBackupUsable()
    && (jsonBackupCoalescer.hasPending() || await hasStoredJsonBackup())
    && await hasReconciledJsonCopy()
);


const jsonIsReadAuthority = (): boolean =>
    shouldUseJsonBackupFastPath() || (jsonAheadOfSqlite && isJsonBackupUsable());


const isPermanentJsonBackupReadError = (error: unknown): boolean => (
    /cursor\s*window|row too big/i.test(formatError(error))
);

const saveStartupJsonBackup = async (
    AsyncStorage: any,
    data: AppData,
    phasePrefix: string,
    minimumUpdatedAtMs = 0,
): Promise<{ sizeChars: number; skipped: boolean }> => {


    if (jsonBackupSkippedOversize && Date.now() - jsonBackupOversizeAtMs < JSON_BACKUP_MIN_INTERVAL_MS) {
        return { sizeChars: jsonBackupOversizeChars, skipped: true };
    }
    const jsonValue = await measureStartupPhase(`${phasePrefix}.json_backup_stringify`, async () => JSON.stringify(data));
    if (jsonValue.length > JSON_BACKUP_MAX_CHARS) {
        jsonBackupSkippedOversize = true;
        jsonBackupOversizeAtMs = Date.now();
        jsonBackupOversizeChars = jsonValue.length;
        logStorageWarn('[Storage] Skipped JSON backup; library exceeds the readable AsyncStorage size', undefined, {
            sizeChars: String(jsonValue.length),
            maxChars: String(JSON_BACKUP_MAX_CHARS),
        });
        return { sizeChars: jsonValue.length, skipped: true };
    }
    jsonBackupSkippedOversize = false;
    jsonBackupOversizeAtMs = 0;
    jsonBackupOversizeChars = 0;
    const updatedAtMs = Math.max(Date.now(), minimumUpdatedAtMs);
    await measureStartupPhase(`${phasePrefix}.json_backup_set`, async () =>
        AsyncStorage.setItem(DATA_KEY, jsonValue)
    );
    await measureStartupPhase(`${phasePrefix}.json_backup_version_set`, async () =>
        AsyncStorage.setItem(STARTUP_BACKUP_VERSION_KEY, STARTUP_BACKUP_VERSION)
    );
    await measureStartupPhase(`${phasePrefix}.json_backup_updated_at_set`, async () =>
        AsyncStorage.setItem(STARTUP_BACKUP_UPDATED_AT_KEY, String(updatedAtMs))
    );
    if (jsonBackupOutgrown !== false) {

        try {
            await AsyncStorage.removeItem(STARTUP_BACKUP_OUTGROWN_AT_KEY);
            jsonBackupOutgrown = false;
        } catch (error) {
            logStorageWarn('[Storage] Failed to clear the outgrown JSON backup marker', error);
        }
    }
    jsonBackupStored = jsonBackupOutgrown === false;
    jsonCopyUnsafe = false;
    return { sizeChars: jsonValue.length, skipped: false };
};


const JSON_BACKUP_COALESCE_MS = 1_000;
const JSON_BACKUP_MIN_INTERVAL_MS = 5 * 60_000;
const WIDGET_REFRESH_MIN_INTERVAL_MS = JSON_BACKUP_MIN_INTERVAL_MS;

type CoalescedPending<TData> = {
    data: TData;
    phasePrefix: string;
    minimumUpdatedAtMs: number;
    coalescedCount: number;
};

type CoalescingWriterOptions<TData, TResult> = {
    coalesceMs: number;
    minIntervalMs: number;


    computeDelayMs?: (lastEndedAtMs: number) => number;


    mergeMinimumUpdatedAtMs?: (prevMs: number, nextMs: number) => number;
    write: (pending: CoalescedPending<TData>) => Promise<TResult>;
    onSlow?: (elapsedMs: number, pending: CoalescedPending<TData>, result: TResult) => void;
    onTimerError: (error: unknown) => void;
};

const computeThrottledDelayMs = (lastEndedAtMs: number, minIntervalMs: number, coalesceMs: number): number => {
    const remainingMs = lastEndedAtMs + minIntervalMs - Date.now();
    return Math.min(Math.max(remainingMs, coalesceMs), minIntervalMs);
};


const createCoalescingWriter = <TData, TResult>(options: CoalescingWriterOptions<TData, TResult>) => {
    const { coalesceMs, minIntervalMs, computeDelayMs, mergeMinimumUpdatedAtMs, write, onSlow, onTimerError } = options;
    let pending: CoalescedPending<TData> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writerChain: Promise<void> = Promise.resolve();
    let inFlight = false;
    let lastEndedAtMs = 0;

    const computeDelay = (): number => (
        computeDelayMs ? computeDelayMs(lastEndedAtMs) : computeThrottledDelayMs(lastEndedAtMs, minIntervalMs, coalesceMs)
    );


    const armTimer = (): void => {
        if (timer || inFlight || !pending) return;
        timer = setTimeout(() => {
            timer = null;
            void writeNext().catch(onTimerError);
        }, computeDelay());
    };

    const writeNext = (): Promise<void> => {
        writerChain = writerChain
            .catch(() => undefined)
            .then(async () => {
                const current = pending;
                if (!current) return;
                pending = null;
                inFlight = true;
                const startedAt = Date.now();
                let result: TResult;
                try {
                    result = await write(current);
                } finally {
                    lastEndedAtMs = Date.now();
                    inFlight = false;
                }
                const elapsedMs = lastEndedAtMs - startedAt;
                if (elapsedMs >= SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS) {
                    onSlow?.(elapsedMs, current, result);
                }


                armTimer();
            });
        return writerChain;
    };

    const schedule = (data: TData, phasePrefix: string, minimumUpdatedAtMs = 0): void => {
        pending = {
            data,
            phasePrefix,
            minimumUpdatedAtMs: mergeMinimumUpdatedAtMs
                ? mergeMinimumUpdatedAtMs(pending?.minimumUpdatedAtMs ?? 0, minimumUpdatedAtMs)
                : minimumUpdatedAtMs,
            coalescedCount: (pending?.coalescedCount ?? 0) + 1,
        };
        armTimer();
    };


    const flush = async (): Promise<void> => {
        while (pending || inFlight) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (pending) {
                await writeNext();
            } else {


                await writerChain.catch(() => undefined);
            }
        }
    };

    const reset = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
        writerChain = Promise.resolve();
        inFlight = false;
        lastEndedAtMs = 0;
    };

    const hasPending = (): boolean => pending !== null || inFlight;

    return { schedule, flush, reset, hasPending };
};

const jsonBackupCoalescer = createCoalescingWriter<AppData, { sizeChars: number; skipped: boolean }>({
    coalesceMs: JSON_BACKUP_COALESCE_MS,
    minIntervalMs: JSON_BACKUP_MIN_INTERVAL_MS,
    mergeMinimumUpdatedAtMs: (prevMs, nextMs) => Math.max(prevMs, nextMs),
    write: async (pending) => {
        if (jsonBackupFrozen) return { sizeChars: 0, skipped: false };
        const result = await saveStartupJsonBackup(AsyncStorage, pending.data, pending.phasePrefix, pending.minimumUpdatedAtMs);
        if (result.skipped) await markJsonBackupOutgrown();
        return result;
    },
    onSlow: (elapsedMs, pending, result) => {
        logStorageInfo('[Storage] Slow post-save backup', {
            jsonBackupMs: String(elapsedMs),


            sizeChars: String(result.sizeChars),
            skipped: String(result.skipped),
            coalescedSaves: String(pending.coalescedCount),
        });
    },
    onTimerError: (error) => {
        logStorageWarn('[Storage] Deferred JSON backup failed', error);
    },
});


const assertJsonFallbackLanded = (): void => {
    if (isJsonBackupUsable()) return;
    throw new Error('SQLite is unavailable and the library is too large for the JSON backup, so this change could not be saved.');
};

const flushPendingStartupJsonBackup = (): Promise<void> => jsonBackupCoalescer.flush();

const isAppForegroundActive = (): boolean => (
    Platform.OS !== 'web'
    && (AppState as unknown as { currentState?: string } | undefined)?.currentState === 'active'
);


const widgetRefreshCoalescer = createCoalescingWriter<AppData, { throttled: boolean }>({
    coalesceMs: JSON_BACKUP_COALESCE_MS,
    minIntervalMs: WIDGET_REFRESH_MIN_INTERVAL_MS,
    computeDelayMs: (lastEndedAtMs) => (
        isAppForegroundActive()
            ? computeThrottledDelayMs(lastEndedAtMs, WIDGET_REFRESH_MIN_INTERVAL_MS, JSON_BACKUP_COALESCE_MS)
            : JSON_BACKUP_COALESCE_MS
    ),
    write: async (pending) => {
        const throttled = isAppForegroundActive();
        try {
            await measureStartupPhase(`${pending.phasePrefix}.widget_update`, async () =>
                updateMobileWidgetFromData(pending.data)
            );
        } catch (error) {
            logStorageWarn('[Widgets] Failed to update mobile widget after backup', error);
        }
        return { throttled };
    },
    onSlow: (elapsedMs, pending, result) => {
        logStorageInfo('[Storage] Slow widget refresh', {
            widgetMs: String(elapsedMs),
            coalescedRefreshes: String(pending.coalescedCount),
            throttled: String(result.throttled),
        });
    },
    onTimerError: (error) => {
        logStorageWarn('[Widgets] Deferred widget refresh failed', error);
    },
});

const scheduleWidgetRefresh = (data: AppData, phasePrefix: string): void => {
    widgetRefreshCoalescer.schedule(data, phasePrefix);
};

const flushPendingWidgetRefresh = (): Promise<void> => widgetRefreshCoalescer.flush();

const scheduleStartupJsonBackup = (
    data: AppData,
    phasePrefix: string,
    minimumUpdatedAtMs = 0,
): void => {
    jsonBackupCoalescer.schedule(data, phasePrefix, minimumUpdatedAtMs);
    scheduleWidgetRefresh(data, phasePrefix);
};

let appStateListenerRegistered = false;


const registerBackgroundFlushListener = (): void => {
    if (Platform.OS === 'web' || appStateListenerRegistered) return;
    const appStateModule = AppState as unknown as { addEventListener?: (...args: any[]) => unknown } | undefined;
    if (typeof appStateModule?.addEventListener !== 'function') return;
    appStateListenerRegistered = true;
    (AppState as any).addEventListener('change', (nextState: string) => {
        if (nextState !== 'background' && nextState !== 'inactive') return;
        flushPendingStartupJsonBackup().catch((error) => {
            logStorageWarn('[Storage] Failed to flush JSON backup on app background', error);
        });
        flushPendingWidgetRefresh().catch((error) => {
            logStorageWarn('[Storage] Failed to flush widget refresh on app background', error);
        });
    });
};

const readStartupJsonBackupUpdatedAt = async (AsyncStorage: any): Promise<number | null> => {
    const raw = await AsyncStorage.getItem(STARTUP_BACKUP_UPDATED_AT_KEY);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const assertJsonBackupFreshEnough = async (AsyncStorage: any, phase: string): Promise<void> => {
    if (latestQueuedWriteStartedAtMs <= 0) return;
    const backupUpdatedAtMs = await readStartupJsonBackupUpdatedAt(AsyncStorage);
    if (backupUpdatedAtMs !== null && backupUpdatedAtMs >= latestQueuedWriteStartedAtMs) return;
    logStorageWarn('[Storage] Refusing stale JSON backup fallback', undefined, {
        phase,
        backupUpdatedAtMs: backupUpdatedAtMs === null ? 'missing' : String(backupUpdatedAtMs),
        latestQueuedWriteStartedAtMs: String(latestQueuedWriteStartedAtMs),
    });
    throw new Error('JSON backup is older than the latest queued SQLite write. Please wait for the save to finish and try again.');
};

export const getMobileStartupSnapshotFromBackup = async (): Promise<AppData | null> => {
    const backupVersion = await AsyncStorage.getItem(STARTUP_BACKUP_VERSION_KEY);
    if (backupVersion !== STARTUP_BACKUP_VERSION || await readJsonBackupOutgrown()) {
        return null;
    }


    if (!await hasReconciledJsonCopy()) return null;
    const jsonValue = await getLegacyJson(AsyncStorage);
    if (jsonValue == null) {
        return null;
    }
    try {
        return parseStoredAppDataJson(jsonValue);
    } catch (error) {
        logStorageWarn('[Storage] Failed to parse startup JSON backup snapshot', error);
        return null;
    }
};


const SQLITE_JSON_RECONCILE_KEY = `${DATA_KEY}:sqlite-json-reconcile-v1`;


const markJsonReconcileDone = async (): Promise<void> => {

    jsonCopyReconciled = true;
    try {
        await AsyncStorage.setItem(SQLITE_JSON_RECONCILE_KEY, '1');
    } catch (error) {
        logStorageWarn('[Storage] Failed to write the JSON reconcile marker', error);
    }
};

const reconcileJsonBackupIntoSqlite = async (
    adapter: SqliteAdapter,
    currentSnapshot?: AppData,
): Promise<void> => {
    if (await AsyncStorage.getItem(SQLITE_JSON_RECONCILE_KEY) != null) return;
    const backupVersion = await AsyncStorage.getItem(STARTUP_BACKUP_VERSION_KEY);
    if (backupVersion !== STARTUP_BACKUP_VERSION) {


        await markJsonReconcileDone();
        return;
    }
    let jsonValue: string | null = null;
    try {
        jsonValue = await getLegacyJson(AsyncStorage);
    } catch (error) {


        if (!isPermanentJsonBackupReadError(error)) throw error;
        logStorageWarn('[Storage] Skipped JSON backup reconcile; backup unreadable', error);
        return;
    }
    if (jsonValue != null) {
        let backup: AppData;
        try {
            backup = parseStoredAppDataJson(jsonValue);
        } catch (error) {

            logStorageWarn('[Storage] Skipped JSON backup reconcile; backup did not parse', error);
            await markJsonReconcileDone();
            return;
        }
        const current = currentSnapshot ?? await adapter.getData();
        const { data: merged, stats } = mergeJsonCopyIntoSqlite(current, backup, 'reconcile');
        await adapter.saveData(merged);


        await replaceJsonCopyAfterMove(merged, 'reconcile');
        logStorageInfo('[Storage] Reconciled JSON backup into SQLite', {
            backupTasks: String(backup.tasks.length),
            sqliteTasks: String(current.tasks.length),
            mergedTasks: String(merged.tasks.length),
            tasksFromBackup: String((stats.tasks?.incomingOnly ?? 0) + (stats.tasks?.resolvedUsingIncoming ?? 0)),
        });
    }
    await markJsonReconcileDone();
};

type JsonCopyMove = 'migrate' | 'reconcile' | 'recover';
const CORE_COPY_MOVE = { migrate: 'migrate', reconcile: 'reconcile', recover: 'json-ahead' } as const;


const mergeJsonCopyIntoSqlite = (current: AppData, copy: AppData, step: JsonCopyMove) => {
    const result = mergeLegacyJsonCopy(current, copy, CORE_COPY_MOVE[step]);
    if (countSqliteCopyRepairs(result.repairs) > 0) {

        void logWarn('[Storage] Repaired the JSON copy before moving it into SQLite', {
            scope: 'storage',
            force: true,
            extra: {
                releaseCheck: 'v1.3.8/rn-copy-repair',
                step,
                ...Object.fromEntries(Object.entries(result.repairs).map(([name, count]) => [name, String(count)])),
            },
        });
    }
    return result;
};


const replaceJsonCopyAfterMove = async (merged: AppData, step: JsonCopyMove): Promise<void> => {
    let refreshed = false;
    try {
        refreshed = !(await saveStartupJsonBackup(AsyncStorage, merged, `mobile.storage.sqlite_init.${step}`)).skipped;
    } catch (error) {
        logStorageWarn('[Storage] Failed to refresh the JSON backup after the move', error, { step });
    }
    if (refreshed) return;
    await markJsonBackupOutgrown();
    if (jsonBackupOutgrown !== true) throw new Error('The old JSON backup could be neither refreshed nor marked outgrown.');
};


const recoverJsonAheadWrites = async (adapter: SqliteAdapter, currentSnapshot?: AppData): Promise<boolean> => {
    let jsonValue: string | null;
    try {
        jsonValue = await getLegacyJson(AsyncStorage);
    } catch (error) {
        if (isPermanentJsonBackupReadError(error)) {


            logStorageWarn('[Storage] JSON-ahead backup is permanently unreadable; abandoning recovery', error);
            await clearJsonAheadOfSqlite();
            return false;
        }


        logStorageWarn('[Storage] Could not read the JSON backup to recover pending writes; keeping marker to retry', error);
        throw new JsonAheadRecoveryReadError(error);
    }
    if (jsonValue == null) {
        await clearJsonAheadOfSqlite();
        return false;
    }
    let backup: AppData;
    try {
        backup = parseStoredAppDataJson(jsonValue);
    } catch (error) {


        logStorageWarn('[Storage] JSON-ahead backup is corrupt; abandoning recovery', error);
        await clearJsonAheadOfSqlite();
        return false;
    }
    const current = currentSnapshot ?? await adapter.getData();
    const { data: merged, stats } = mergeJsonCopyIntoSqlite(current, backup, 'recover');
    await adapter.saveData(merged);


    jsonAheadOfSqlite = false;
    try {
        await replaceJsonCopyAfterMove(merged, 'recover');
        await removeJsonAheadMarker();
    } catch (error) {

        jsonCopyUnsafe = true;
        logStorageWarn('[Storage] JSON copy left unsafe after recovering JSON-ahead writes', error);
    }
    logStorageInfo('[Storage] Recovered JSON-only writes into SQLite', {
        backupTasks: String(backup.tasks.length),
        sqliteTasks: String(current.tasks.length),
        mergedTasks: String(merged.tasks.length),
        tasksFromBackup: String((stats.tasks?.incomingOnly ?? 0) + (stats.tasks?.resolvedUsingIncoming ?? 0)),
    });
    return true;
};


const logMigrationFailure = (step: 'migrate' | 'reconcile', error: unknown): void => {
    void logWarn(step === 'migrate'
        ? '[Storage] JSON migration into SQLite failed; saving is blocked'
        : '[Storage] JSON reconcile into SQLite failed; JSON backup frozen', {
        scope: 'storage',
        force: true,
        extra: { releaseCheck: 'v1.3.8/rn-migration-write-block', step, error: formatError(error) },
    });
};

const prepareSqliteData = async (adapter: SqliteAdapter, client: SqliteClient): Promise<boolean> => {

    jsonBackupFrozen = false;
    let recoveredJsonAhead = false;
    if (await readJsonAheadOfSqlite()) {
        recoveredJsonAhead = await measureStartupPhase('mobile.storage.sqlite_init.recover_json_ahead', async () =>
            recoverJsonAheadWrites(adapter)
        );
    }
    let readableSnapshot: AppData | undefined;
    let hasData: boolean;
    try {
        hasData = await measureStartupPhase('mobile.storage.sqlite_init.has_any_data', async () =>
            sqliteHasAnyData(client)
        );
    } catch (error) {


        if (__DEV__) {
            logStorageWarn('[Storage] SQLite availability check failed; using full read', error);
        }
        readableSnapshot = await adapter.getData();
        hasData = (readableSnapshot.tasks?.length ?? 0) > 0
            || (readableSnapshot.projects?.length ?? 0) > 0
            || (readableSnapshot.sections?.length ?? 0) > 0
            || (readableSnapshot.areas?.length ?? 0) > 0
            || (readableSnapshot.people?.length ?? 0) > 0
            || Object.keys(readableSnapshot.settings ?? {}).length > 0;
    }
    if (hasData) {
        try {
            await measureStartupPhase('mobile.storage.sqlite_init.reconcile_json_backup', async () =>
                reconcileJsonBackupIntoSqlite(adapter, readableSnapshot)
            );
        } catch (error) {


            jsonBackupFrozen = true;
            clearPreferJsonBackup();
            logMigrationFailure('reconcile', error);
        }
        return recoveredJsonAhead;
    }

    const jsonValue = await measureStartupPhase('mobile.storage.sqlite_init.read_legacy_json', async () =>
        getLegacyJson(AsyncStorage)
    );

    if (jsonValue == null) {
        await markJsonReconcileDone();
        return recoveredJsonAhead;
    }
    let backup: AppData;
    try {
        backup = parseStoredAppDataJson(jsonValue);
    } catch (error) {

        logStorageWarn('[Storage] Skipped JSON migration; backup did not parse', error);
        await markJsonReconcileDone();
        return recoveredJsonAhead;
    }
    try {


        const current = readableSnapshot ?? await adapter.getData();
        const { data: merged } = mergeJsonCopyIntoSqlite(current, backup, 'migrate');
        try {

            await saveStartupJsonBackup(AsyncStorage, merged, 'mobile.storage.sqlite_init.migrate');
        } catch (error) {
            logStorageWarn('[Storage] Failed to refresh the JSON backup before migration', error);
        }
        await measureStartupPhase('mobile.storage.sqlite_init.migrate_json_to_sqlite', async () =>
            adapter.saveData(merged)
        );
    } catch (error) {
        throw new JsonMigrationFailedError(jsonValue, error);
    }
    await markJsonReconcileDone();
    return recoveredJsonAhead;
};

const prepareSqliteState = async (adapter: SqliteAdapter, client: SqliteClient): Promise<SqliteState> => {
    try {
        const recoveredJsonAhead = await prepareSqliteData(adapter, client);
        if (recoveredJsonAhead) requireCanonicalReload();
        return { adapter, client };
    } catch (error) {
        if (error instanceof JsonAheadRecoveryReadError) {
            requireCanonicalReload();
            markStartupPhase('mobile.storage.sqlite_init.write_quarantined');
            return { adapter, client, writeBlockedReason: 'json-ahead-recovery-read' };
        }
        if (error instanceof JsonMigrationFailedError) {


            logMigrationFailure('migrate', error);
            markStartupPhase('mobile.storage.sqlite_init.write_quarantined');
            return { adapter, client, writeBlockedReason: 'json-migration-failed', jsonCopy: error.jsonCopy };
        }
        if (__DEV__) {
            logStorageWarn('[Storage] SQLite availability check failed', error);
        }
        throw error;
    }
};

const initSqliteState = async (): Promise<SqliteState> => {
    markStartupPhase('mobile.storage.sqlite_init.start');
    const client = await measureStartupPhase('mobile.storage.sqlite_init.create_client', async () => createSqliteClient());
    const adapter = new SqliteAdapter(client);
    await measureStartupPhase('mobile.storage.sqlite_init.ensure_schema', async () => adapter.ensureSchema());


    try {
        const journalRow = await client.get<{ journal_mode?: string }>('PRAGMA journal_mode');
        const busyRow = await client.get<{ timeout?: number }>('PRAGMA busy_timeout');


        const tempStoreRow = await client.get<{ temp_store?: number }>('PRAGMA temp_store');
        sqliteJournalDiagnostics = {
            journalMode: String(journalRow?.journal_mode ?? 'unknown'),
            busyTimeoutMs: String(busyRow?.timeout ?? 'unknown'),
            tempStore: String(tempStoreRow?.temp_store ?? 'unknown'),
            openMode: sqliteOpenMode,
            ...(sqliteDbPath ? { dbPath: sqliteDbPath } : {}),
        };
        logStorageInfo('[Storage] SQLite journal mode ready', sqliteJournalDiagnostics);
    } catch (error) {
        logStorageWarn('[Storage] Failed to read SQLite journal mode', error);
    }
    const state = await prepareSqliteState(adapter, client);
    markStartupPhase('mobile.storage.sqlite_init.end');
    return state;
};

let initializeSqliteState = initSqliteState;

const startSqliteStateInitialization = (): Promise<SqliteState> => {
    const promise = initializeSqliteState().then(
        (state) => {
            if (sqliteStatePromise === promise && state.writeBlockedReason) {
                sqliteStateRetryAfter = Date.now() + SQLITE_RETRY_COOLDOWN_MS;
            }
            return state;
        },
        (error) => {
            if (sqliteStatePromise === promise) {
                sqliteStateRetryAfter = Date.now() + SQLITE_RETRY_COOLDOWN_MS;
            }
            throw error;
        }
    );
    sqliteStatePromise = promise;
    return promise;
};

const getSqliteState = async (): Promise<SqliteState> => {
    if (sqliteStatePromise && sqliteStateRetryAfter > 0 && Date.now() >= sqliteStateRetryAfter) {
        markStartupPhase('mobile.storage.sqlite_state.retry_cooldown_elapsed');
        sqliteStatePromise = null;
        sqliteStateRetryAfter = 0;
    }
    let statePromise = sqliteStatePromise;
    if (!statePromise) {
        markStartupPhase('mobile.storage.sqlite_state.cache_miss');
        statePromise = startSqliteStateInitialization();
    } else {
        markStartupPhase('mobile.storage.sqlite_state.cache_hit');
    }
    try {
        const state = await statePromise;
        if (!state.writeBlockedReason) {
            sqliteStateRetryAfter = 0;
        }
        markStartupPhase('mobile.storage.sqlite_state.ready');
        return state;
    } catch (error) {
        markStartupPhase('mobile.storage.sqlite_state.unavailable_during_cooldown');
        throw error;
    }
};


const createStorage = (): StorageAdapter => {

    if (Platform.OS === 'web') {
        return {
            getData: async (): Promise<AppData> => {
                if (typeof window === 'undefined') {
                    return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
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
                    return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
                }
                try {
                    const data = parseStoredAppDataJson(jsonValue);
                    return data;
                } catch (e) {

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


    const sqliteUnavailableReason = getSqliteUnavailableReason();
    const shouldUseSqlite = sqliteUnavailableReason == null;
    registerBackgroundFlushListener();

    return {
        getData: async (): Promise<AppData> => {
            markStartupPhase('mobile.storage.get_data.start');


            const loadJsonBackup = async (phase = 'get_data', allowEmptyOnAbsent = !shouldUseSqlite) => {


                await flushPendingStartupJsonBackup();
                if (!isJsonBackupUsable()) {


                    logStorageWarn('[Storage] Refusing oversized JSON backup fallback', undefined, { phase });
                    throw new Error('The library is too large for the local JSON backup; SQLite is the only readable copy.');
                }
                if (!isJsonCopyServable()) {
                    logStorageWarn('[Storage] Refusing unsafe JSON backup fallback', undefined, { phase });
                    throw new Error('The JSON backup may hold data SQLite overrules; SQLite is the only readable copy.');
                }
                if (shouldUseSqlite && await readJsonBackupOutgrown()) {

                    logStorageWarn('[Storage] Refusing outgrown JSON backup fallback', undefined, { phase });
                    throw new Error('The JSON backup is older than the library; SQLite is the only readable copy.');
                }
                await assertJsonBackupFreshEnough(AsyncStorage, phase);
                const jsonValue = await getLegacyJson(AsyncStorage);
                if (jsonValue == null) {
                    if (!allowEmptyOnAbsent) {
                        throw new Error(`JSON backup is absent; nothing to serve from ${phase}.`);
                    }
                    return { ...EMPTY_APP_DATA };
                }
                if (jsonValue != null) {
                    try {
                        const data = parseStoredAppDataJson(jsonValue);


                        scheduleWidgetRefresh(data, 'mobile.storage.get_data.json_fallback');
                        return data;
                    } catch (parseError) {
                        logStorageError('Failed to parse stored data - may be corrupted', parseError);
                    }
                }
                throw new Error('Data appears corrupted. Please restore from backup.');
            };

            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                return loadJsonBackup('json_fast_path');
            }
            if (preferJsonBackup && !shouldUseSqlite) {
                warnPreferJsonBackup();
                return loadJsonBackup('json_preferred_sqlite_disabled');
            }
            if (preferJsonBackup) {
                warnPreferJsonBackup();
            }


            if (jsonAheadOfSqlite && isJsonBackupUsable()) {
                try {
                    return await loadJsonBackup('json_ahead', false);
                } catch (error) {
                    logStorageWarn('[Storage] Failed to load the JSON-ahead backup; falling back to SQLite read', error);
                }
            }


            let hasJsonFallback = true;
            try {
                if (!shouldUseSqlite) {
                    throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                }


                hasJsonFallback = await hasUsableJsonBackup();
                const readTimeoutMs = hasJsonFallback
                    ? SQLITE_STARTUP_TIMEOUT_MS
                    : SQLITE_NO_FALLBACK_READ_TIMEOUT_MS;
                await measureStartupPhase(
                    'mobile.storage.get_data.await_sqlite_writes',
                    async () => awaitQueuedSqliteWrites(
                        'get_data',
                        hasJsonFallback ? SQLITE_WRITE_WAIT_TIMEOUT_MS : SQLITE_NO_FALLBACK_READ_TIMEOUT_MS
                    )
                );
                const state = await measureStartupPhase('mobile.storage.get_data.sqlite_get_state', async () =>
                    withOperationTimeout(
                        getSqliteState(),
                        readTimeoutMs,
                        'SQLite initialization timed out'
                    )
                );
                if (state.jsonCopy != null) {


                    return repairAppDataForSqlite(parseStoredAppDataJson(state.jsonCopy)).data;
                }
                const { adapter } = state;
                const readStartedAt = Date.now();
                const data = await measureStartupPhase('mobile.storage.get_data.sqlite_read', async () =>
                    withOperationTimeout(
                        adapter.getData(),
                        readTimeoutMs,
                        'SQLite read timed out'
                    )
                );
                const readMs = Date.now() - readStartedAt;
                if (readMs >= SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS) {


                    logStorageInfo('[Storage] Slow SQLite load', {
                        readMs: String(readMs),
                        readTimeoutMs: String(readTimeoutMs),
                        ...(sqliteJournalDiagnostics ?? {}),
                    });
                }
                data.areas = Array.isArray(data.areas) ? data.areas : [];


                if (!state.writeBlockedReason && canonicalReloadRequired) {
                    canonicalReloadCandidates.add(data);
                }
                if (!jsonAheadOfSqlite) {


                    scheduleStartupJsonBackup(data, 'mobile.storage.get_data', latestQueuedWriteStartedAtMs);
                }
                markStartupPhase('mobile.storage.get_data.widget_update_dispatched');
                clearPreferJsonBackup();
                markStartupPhase('mobile.storage.get_data.end');
                return data;
            } catch (e) {
                if (!hasJsonFallback || !isJsonBackupUsable() || !isJsonCopyServable()) {


                    logStorageWarn('[Storage] SQLite load failed and no JSON backup can serve it; retrying SQLite next read', e);
                    markStartupPhase('mobile.storage.get_data.error');
                    throw e;
                }
                if (__DEV__ && sqliteUnavailableReason) {
                    logStorageWarn(`[Storage] ${sqliteUnavailableReason}; falling back to JSON backup`);
                } else {
                    logStorageWarn('[Storage] SQLite load failed, falling back to JSON backup', e);
                }
                const fallbackData = await measureStartupPhase('mobile.storage.get_data.json_fallback_read', async () => loadJsonBackup('get_data_fallback'));

                markPreferJsonBackup();
                markStartupPhase('mobile.storage.get_data.end');
                return fallbackData;
            }
        },
        acknowledgeDataLoad: (data: AppData): void => {
            if (!canonicalReloadRequired || !canonicalReloadCandidates.has(data)) return;
            canonicalReloadRequired = false;
            canonicalReloadCandidates = new WeakSet<AppData>();
        },
        saveData: async (data: AppData): Promise<void> => {
            const enqueuedAtMs = Date.now();
            const reloadRequiredWhenEnqueued = canonicalReloadRequired;
            return enqueueSave(async () => {
                markStartupPhase('mobile.storage.save_data.start');
                const queueWaitMs = Date.now() - enqueuedAtMs;


                let queuedWriteStartedAtMs = 0;
                try {
                    if (!shouldUseSqlite) {
                        throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                    }
                    const state = await measureStartupPhase('mobile.storage.save_data.sqlite_get_state', async () => getSqliteState());
                    assertSqliteWritesAllowed(state, reloadRequiredWhenEnqueued);
                    queuedWriteStartedAtMs = markQueuedWriteStarted();
                    const { adapter } = state;


                    let eventLoopLagMs = -1;
                    const lagProbeStartedAt = Date.now();
                    setTimeout(() => {
                        eventLoopLagMs = Date.now() - lagProbeStartedAt;
                    }, 0);
                    const writeStartedAt = Date.now();
                    await measureStartupPhase('mobile.storage.save_data.sqlite_write', async () => adapter.saveData(data));
                    const writeMs = Date.now() - writeStartedAt;


                    const rewriteStats = adapter.getLastSaveDataStats?.();
                    if (rewriteStats?.rewriteDiagnostics?.length) {
                        logStorageInfo('[Storage] Large incremental rewrite', {
                            writeMs: String(writeMs),
                            rowsWritten: String(rewriteStats.writtenRows),
                            rowsTotal: String(rewriteStats.totalRows),
                            diagnostics: JSON.stringify(rewriteStats.rewriteDiagnostics),
                        });
                    }
                    if (writeMs >= SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS) {
                        const stats = adapter.getLastSaveDataStats?.();
                        logStorageInfo('[Storage] Slow SQLite save', {
                            writeMs: String(writeMs),
                            queueWaitMs: String(queueWaitMs),
                            eventLoopLagMs: String(eventLoopLagMs),
                            ...(stats
                                ? {
                                    rowsWritten: String(stats.writtenRows),
                                    rowsRemoved: String(stats.removedRows),
                                    rowsTotal: String(stats.totalRows),
                                    incremental: String(stats.incremental),
                                    settingsWritten: String(stats.settingsWritten),
                                    sqlMs: String(stats.sqlMs),
                                    sqlCount: String(stats.sqlCount),
                                    beginMs: String(stats.beginMs),
                                    commitMs: String(stats.commitMs),
                                }
                                : {}),
                            ...(sqliteJournalDiagnostics ?? {}),
                        });
                    }
                    clearPreferJsonBackup();


                    await clearJsonAheadOfSqlite();


                    scheduleStartupJsonBackup(data, 'mobile.storage.save_data', queuedWriteStartedAtMs);
                    markStartupPhase('mobile.storage.save_data.end');
                } catch (error) {
                    if (error instanceof SqliteWriteBlockedError) {
                        markStartupPhase('mobile.storage.save_data.write_quarantined');
                        throw error;
                    }
                    assertJsonBackupNotFrozen(error);
                    queuedWriteStartedAtMs ||= markQueuedWriteStarted();
                    markPreferJsonBackup();
                    if (__DEV__ && sqliteUnavailableReason) {
                        logStorageWarn(`[Storage] ${sqliteUnavailableReason}; keeping JSON backup`);
                    } else {
                        logStorageWarn('[Storage] SQLite save failed, keeping JSON backup', error);
                    }
                    try {


                        await markJsonAheadOfSqlite();


                        scheduleStartupJsonBackup(data, 'mobile.storage.save_data.json_fallback', queuedWriteStartedAtMs);
                        await flushPendingStartupJsonBackup();
                        assertJsonFallbackLanded();
                        markStartupPhase('mobile.storage.save_data.end');
                    } catch (e) {
                        markStartupPhase('mobile.storage.save_data.error');
                        logStorageError('Failed to save data', e);
                        throw new Error('Failed to save data: ' + (e as Error).message);
                    }
                }
            });
        },
        saveTask: async (task: Task, snapshot?: AppData): Promise<void> => {
            const enqueuedAtMs = Date.now();
            const reloadRequiredWhenEnqueued = canonicalReloadRequired;
            return enqueueSave(async () => {
                const queueWaitMs = Date.now() - enqueuedAtMs;
                let queuedWriteStartedAtMs = 0;
                try {
                    if (!shouldUseSqlite) {
                        throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                    }
                    const state = await measureStartupPhase('mobile.storage.save_task.sqlite_get_state', async () => getSqliteState());
                    assertSqliteWritesAllowed(state, reloadRequiredWhenEnqueued);
                    queuedWriteStartedAtMs = markQueuedWriteStarted();
                    const { adapter } = state;


                    let eventLoopLagMs = -1;
                    const lagProbeStartedAt = Date.now();
                    setTimeout(() => {
                        eventLoopLagMs = Date.now() - lagProbeStartedAt;
                    }, 0);
                    const writeStartedAt = Date.now();
                    await measureStartupPhase('mobile.storage.save_task.sqlite_write', async () => adapter.saveTask(task));
                    const writeMs = Date.now() - writeStartedAt;
                    clearPreferJsonBackup();
                    if (snapshot) {
                        scheduleStartupJsonBackup(snapshot, 'mobile.storage.save_task', queuedWriteStartedAtMs);
                    }
                    if (writeMs >= SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS) {
                        logStorageInfo('[Storage] Slow task save', {
                            writeMs: String(writeMs),
                            queueWaitMs: String(queueWaitMs),
                            eventLoopLagMs: String(eventLoopLagMs),
                        });
                    }
                } catch (error) {
                    if (error instanceof SqliteWriteBlockedError) {
                        throw error;
                    }
                    assertJsonBackupNotFrozen(error);
                    queuedWriteStartedAtMs ||= markQueuedWriteStarted();
                    logStorageWarn('[Storage] SQLite task save failed', error);
                    if (!snapshot) {


                        if (await hasUsableJsonBackup()) markPreferJsonBackup();
                        throw error;
                    }
                    markPreferJsonBackup();

                    try {
                        await markJsonAheadOfSqlite();


                        scheduleStartupJsonBackup(snapshot, 'mobile.storage.save_task.json_fallback', queuedWriteStartedAtMs);
                        await flushPendingStartupJsonBackup();
                        assertJsonFallbackLanded();
                    } catch (fallbackError) {
                        logStorageError('Failed to save task fallback data', fallbackError);
                        throw new Error('Failed to save task: ' + (fallbackError as Error).message);
                    }
                }
            });
        },
        queryTasks: async (options) => {


            if (jsonIsReadAuthority()) {
                if (shouldUseJsonBackupFastPath()) {
                    warnPreferJsonBackup();
                }
                const data = await mobileStorage.getData();
                return data.tasks.filter((task) => taskMatchesQuery(task, options));
            }
            try {
                await awaitQueuedSqliteWrites('query_tasks');
                const { adapter, writeBlockedReason } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite query initialization timed out'
                );

                if (writeBlockedReason !== 'json-migration-failed' && typeof (adapter as any).queryTasks === 'function') {
                    return await withOperationTimeout(
                        (adapter as any).queryTasks(options),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite query timed out'
                    );
                }
            } catch (error) {

                if (await hasUsableJsonBackup()) markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite query failed, falling back to in-memory filter', error);
            }
            const data = await mobileStorage.getData();
            return data.tasks.filter((task) => taskMatchesQuery(task, options));
        },
        searchAll: async (query: string) => {
            if (jsonIsReadAuthority()) {
                if (shouldUseJsonBackupFastPath()) {
                    warnPreferJsonBackup();
                }
                const data = await mobileStorage.getData();
                return searchAll(data.tasks, data.projects, query);
            }
            try {
                await awaitQueuedSqliteWrites('search_all');
                const { adapter, writeBlockedReason } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite search initialization timed out'
                );
                if (writeBlockedReason !== 'json-migration-failed' && typeof (adapter as any).searchAll === 'function') {
                    return await withOperationTimeout(
                        (adapter as any).searchAll(query),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite search timed out'
                    );
                }
            } catch (error) {
                if (await hasUsableJsonBackup()) markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite search failed, falling back to in-memory search', error);
            }
            const data = await mobileStorage.getData();
            return searchAll(data.tasks, data.projects, query);
        },
    };
};

export const mobileStorage = createStorage();


const drainMobileStorageWork = async (): Promise<void> => {
    await waitForQueuedSqliteWrites();
    await flushPendingStartupJsonBackup();
    await flushPendingWidgetRefresh();
};


export const quiesceMobileStorageForWorkspaceSwitch = drainMobileStorageWork;

export const quiesceMobileStorage = async (): Promise<void> => {
    try {
        await drainMobileStorageWork();
    } catch (error) {
        logStorageWarn('[Storage] Failed to quiesce storage before teardown', error);
    }
};

export const __mobileStorageTestUtils = {
    createOpSqliteClientForTests: createOpSqliteClient,
    flushPendingStartupJsonBackup,
    flushPendingWidgetRefresh,
    prepareSqliteDataForTests: prepareSqliteData,
    prepareSqliteStateForTests: prepareSqliteState,
    reconcileJsonBackupIntoSqliteForTests: reconcileJsonBackupIntoSqlite,
    recoverJsonAheadWritesForTests: recoverJsonAheadWrites,
    jsonAheadOfSqliteKeyForTests: JSON_AHEAD_OF_SQLITE_KEY,
    sqliteHasAnyDataForTests: sqliteHasAnyData,
    reset: () => {
        saveQueue = Promise.resolve();
        sqliteStatePromise = null;
        sqliteStateRetryAfter = 0;
        canonicalReloadRequired = false;
        canonicalReloadCandidates = new WeakSet<AppData>();
        latestQueuedWriteStartedAtMs = 0;
        jsonBackupCoalescer.reset();
        jsonBackupSkippedOversize = false;
        jsonBackupOversizeAtMs = 0;
        jsonBackupOversizeChars = 0;
        jsonBackupStored = null;
        jsonBackupOutgrown = null;
        jsonBackupFrozen = false;
        jsonCopyUnsafe = false;
        jsonCopyReconciled = false;
        didLogUnreconciledJsonCopy = false;
        widgetRefreshCoalescer.reset();
        initializeSqliteState = initSqliteState;
        jsonAheadOfSqlite = false;
        clearPreferJsonBackup();
    },
    setSqliteInitializerForTests: (initializer: () => Promise<SqliteState>) => {
        sqliteStatePromise = null;
        sqliteStateRetryAfter = 0;
        initializeSqliteState = initializer;
        clearPreferJsonBackup();
    },
    setSqliteStateForTests: (state: { adapter: Pick<SqliteAdapter, 'saveTask'> & Partial<Pick<SqliteAdapter, 'getData'>>; client: Partial<SqliteClient> }) => {
        sqliteStatePromise = Promise.resolve(state as SqliteState);
        sqliteStateRetryAfter = 0;
        clearPreferJsonBackup();
    },
};


export const ensureCalendarSyncStorageReady = async (): Promise<void> => {
    await getSqliteState();
};

export const getCalendarSyncEntry = async (taskId: string, platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.getCalendarSyncEntry(taskId, platform);
};

export const upsertCalendarSyncEntry = async (entry: CalendarSyncEntry) => {
    const { adapter } = await getSqliteState();
    return adapter.upsertCalendarSyncEntry(entry);
};

export const deleteCalendarSyncEntry = async (taskId: string, platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.deleteCalendarSyncEntry(taskId, platform);
};

export const getAllCalendarSyncEntries = async (platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.getAllCalendarSyncEntries(platform);
};
