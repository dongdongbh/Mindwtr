import { AppData, mergeAppDataWithStats, SqliteAdapter, searchAll, splitSqlStatements, taskMatchesQuery, type SqliteClient, type CalendarSyncEntry, StorageAdapter, type Task } from '@mindwtr/core';
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
// Set while the JSON backup holds writes SQLite refused. Survives the process,
// because the loss it prevents only shows up on the NEXT launch: SQLite reads
// keep succeeding, so without this marker the app happily serves the stale
// database and every change taken by the fallback is silently dropped (#964).
const JSON_AHEAD_OF_SQLITE_KEY = `${DATA_KEY}:json-ahead-of-sqlite`;
const STARTUP_BACKUP_VERSION = '2';
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];
const EMPTY_APP_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
const SQLITE_STARTUP_TIMEOUT_MS = 3_500;
// The 3.5s cap exists to fail fast INTO the JSON backup. When that backup is
// unusable (skipped as oversized, #766) there is nothing to fall back to, so a
// fast failure only fails the caller — on a slow device a contended read can
// legitimately take >3.5s while sync writes land. Keep a bound (a stalled
// native promise must not hang reads forever) but give real reads room.
const SQLITE_NO_FALLBACK_READ_TIMEOUT_MS = 15_000;
const SQLITE_QUERY_TIMEOUT_MS = 2_500;
const SQLITE_RETRY_COOLDOWN_MS = 60_000;
const SQLITE_NATIVE_MODULE_UNAVAILABLE = 'Native SQLite module unavailable; rebuild or reinstall the app so op-sqlite is included';
// Cap how long a read may block on in-flight writes so a stalled save (e.g. a
// lost-promise native call) degrades to the existing fallback instead of hanging the UI.
const SQLITE_WRITE_WAIT_TIMEOUT_MS = 3_000;
// Diagnostics: only log waits/saves slow enough to matter, to keep the shared beta log readable.
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
// expo-sqlite stored the database under <documentDirectory>/SQLite; op-sqlite must
// open the exact same directory or existing installs would come up empty (ADR 0024).
const SQLITE_DIRECTORY_NAME = 'SQLite';

type SqliteState = {
    adapter: SqliteAdapter;
    client: SqliteClient;
    writeBlockedReason?: 'json-ahead-recovery-read';
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

class SqliteWriteBlockedError extends Error {
    constructor(reason: 'json-ahead-recovery-read' | 'canonical-reload') {
        super(reason === 'canonical-reload'
            ? 'Pending local changes were recovered. Reload Mindwtr before saving again.'
            : 'Saving is temporarily disabled while Mindwtr retries recovery of pending local changes.');
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
        // The caller's snapshot may have been built from SQLite while the
        // unreadable JSON-ahead backup was quarantined. Accepting it now would
        // immediately erase the rows/settings that initialization just recovered.
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

// Diagnostic breadcrumb for the shared beta log; only written when diagnostics logging is on.
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

// Wait for in-flight SQLite writes to finish before reading, but bounded: a save that
// stalls must not strand reads (each read site falls back when this throws).
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

const shouldUseJsonBackupFastPath = () => preferJsonBackup && Date.now() < preferJsonBackupUntil;

// Mirrors JSON_AHEAD_OF_SQLITE_KEY so the common path (SQLite healthy) never
// pays an AsyncStorage write per save.
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

const clearJsonAheadOfSqlite = async (): Promise<void> => {
    if (!jsonAheadOfSqlite) return;
    jsonAheadOfSqlite = false;
    try {
        await AsyncStorage.removeItem(JSON_AHEAD_OF_SQLITE_KEY);
    } catch (error) {
        logStorageWarn('[Storage] Failed to clear the JSON-ahead marker', error);
    }
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
        // op-sqlite rejects undefined bindings; the adapter's row builders emit null,
        // so mapping here only guards stray callers.
        const args = params.map((value) => (value === undefined ? null : value));
        return db.execute(sql, args);
    };

    // op-sqlite prepares a single statement per execute call, so multi-statement
    // schema strings are split and run one by one on the shared connection. Each
    // statement executes directly (no wrapper transaction), so connection pragmas
    // (journal_mode) apply for real and the adapter's explicit BEGIN IMMEDIATE…COMMIT
    // stays intact instead of committing per statement (#766). Splitting must be
    // trigger-aware: a naive split on ';' cuts CREATE TRIGGER bodies apart and
    // every statement fails with "incomplete input" (1.1.5-rc.1 regression).
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
        // fall through to the legacy API
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const LegacyFileSystem = require('expo-file-system/legacy');
        const documentDirectory: string | null | undefined = LegacyFileSystem?.documentDirectory;
        if (documentDirectory) {
            return `${documentDirectory.replace(/\/+$/, '')}/${SQLITE_DIRECTORY_NAME}`;
        }
    } catch {
        // resolved below as an error
    }
    return null;
};

// Fresh installs have no <documentDirectory>/SQLite yet; sqlite3_open does not
// create missing parent directories.
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
    // Use require to avoid async bundle loading in dev client.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { open } = require('@op-engineering/op-sqlite');
    const directoryUri = resolveSqliteDirectoryUri();
    if (!directoryUri) {
        // Opening at op-sqlite's default location would look like an empty database
        // to existing installs; failing here routes callers to the JSON backup instead.
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
            await AsyncStorage.setItem(DATA_KEY, legacyValue);
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

// Android hands an AsyncStorage row back through a ~2MB CursorWindow, so a
// backup past that limit can never be read again ("Row too big to fit into
// CursorWindow"): writing it costs seconds of JS thread for a copy nothing can
// load, and trusting it turns a transient SQLite timeout into a hard sync
// failure. Past the limit the backup is skipped and treated as absent (#766).
// This is Android-only: iOS AsyncStorage is file-backed with no CursorWindow
// row limit, and the JSON backup is iOS's only fallback when SQLite fails
// (e.g. a missing native module), so capping it there would turn a SQLite
// failure into total, unrecoverable save loss (#979).
const JSON_BACKUP_MAX_CHARS = Platform.OS === 'android' ? 1_500_000 : Number.POSITIVE_INFINITY;
let jsonBackupSkippedOversize = false;
// Set alongside the flag above so an oversized library re-measures on the
// backup's own cadence instead of on every flush (see saveStartupJsonBackup).
let jsonBackupOversizeAtMs = 0;
let jsonBackupOversizeChars = 0;

const isJsonBackupUsable = (): boolean => !jsonBackupSkippedOversize;

// The #975 read-authority rule: reads come from the JSON backup while it is
// preferred (fast path) or holds writes SQLite hasn't taken yet (json-ahead).
// getData() applies the same rule in expanded form for per-branch telemetry.
const jsonIsReadAuthority = (): boolean =>
    shouldUseJsonBackupFastPath() || (jsonAheadOfSqlite && isJsonBackupUsable());

// Distinguishes a permanent Android CursorWindow overflow (the row can never be
// read back, so recovery must give up) from a transient AsyncStorage error
// (worth retrying on the next launch) when reading the JSON-ahead backup.
const isPermanentJsonBackupReadError = (error: unknown): boolean => (
    /cursor\s*window|row too big/i.test(formatError(error))
);

const saveStartupJsonBackup = async (
    AsyncStorage: any,
    data: AppData,
    phasePrefix: string,
    minimumUpdatedAtMs = 0,
): Promise<{ sizeChars: number; skipped: boolean }> => {
    // Serializing multiple MB blocks the JS thread, and past the cap the string
    // is thrown away. The coalescer throttles the timer path but flush() (app
    // background, SQLite-failure fallback) bypasses it, so an oversized library
    // paid that stringify on every flush for nothing. Re-measure no more often
    // than the backup's own interval: a library that shrinks back under the cap
    // still recovers, one that stays over stops re-serializing itself (#766).
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
    return { sizeChars: jsonValue.length, skipped: false };
};

// The full-dataset JSON backup (stringify + AsyncStorage write) and the widget
// render took multiple seconds per save on large libraries and ran inside the
// save queue, so every read and every following tap waited on them (#766).
// Saves whose SQLite write succeeded only *schedule* the backup here: a single
// pending slot keeps the newest payload, a trailing timer coalesces bursts, and
// one serialized writer preserves write order. Paths where the backup IS the
// durable copy (SQLite failure) or where a fallback read is about to trust it
// await flushPendingStartupJsonBackup() to keep the freshness invariant
// (backupUpdatedAt >= latestQueuedWriteStartedAt) observable at read time.
//
// Even coalesced, the stringify + AsyncStorage write alone can take 10-20s on
// large libraries and starves the JS thread while it runs. SQLite is the
// durable copy on the healthy path, so the JSON copy (a downgrade/rollback
// safety net) only needs to land once every JSON_BACKUP_MIN_INTERVAL_MS while
// saves keep arriving; an AppState background/inactive transition flushes it
// immediately so the AsyncStorage copy stays close to fresh across process
// death (#766).
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
    // Overrides the default remaining-time calc below; receives the writer's
    // own lastEndedAtMs so an override can still fall back to the default shape
    // (the widget writer uses this for its background short-circuit).
    computeDelayMs?: (lastEndedAtMs: number) => number;
    // How to combine a newly-scheduled minimumUpdatedAtMs with whatever the
    // still-pending payload already carries. Defaults to "replace" (last
    // schedule wins); the JSON backup writer needs the max across coalesced
    // saves instead (see its instantiation below).
    mergeMinimumUpdatedAtMs?: (prevMs: number, nextMs: number) => number;
    write: (pending: CoalescedPending<TData>) => Promise<TResult>;
    onSlow?: (elapsedMs: number, pending: CoalescedPending<TData>, result: TResult) => void;
    onTimerError: (error: unknown) => void;
};

const computeThrottledDelayMs = (lastEndedAtMs: number, minIntervalMs: number, coalesceMs: number): number => {
    const remainingMs = lastEndedAtMs + minIntervalMs - Date.now();
    return Math.min(Math.max(remainingMs, coalesceMs), minIntervalMs);
};

// Shared shape behind the JSON backup and widget refresh writers below: a
// single pending slot keyed on the newest payload, a trailing timer that
// coalesces bursts, and one serialized writer so overlapping schedules never
// race each other onto disk out of order (#766).
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

    // Only arms while nothing else will trigger a write: a timer already
    // pending, or a write currently in flight (which re-arms itself on
    // completion, using the freshly-updated lastEndedAtMs, if more work
    // queued up behind it). This keeps the throttle correct even when
    // schedules arrive faster than a single write finishes. Both the JSON
    // backup and widget refresh instantiations rely on this to avoid
    // double-scheduling overlapping writes (#766).
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
                // A schedule that arrived while this write was in flight left
                // `pending` set but couldn't arm a timer (inFlight guarded it);
                // arm the next throttle window now that lastEndedAtMs is current.
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

    // Loop-drain — unlike the throttled timer path (armTimer above), a flush
    // must land the newest pending payload even if a concurrent,
    // non-serialized caller (e.g. a fallback read racing a save) enqueues a
    // newer one while this flush is still waiting on an in-flight write.
    // Without the loop, a single write-then-return could leave a fresher
    // payload behind a just-armed throttle window. The JSON backup
    // instantiation depends on this for its freshness invariant
    // (backupUpdatedAt >= latestQueuedWriteStartedAt) to hold right after
    // flush; the widget instantiation depends on the same shape so a
    // background flush doesn't leave a stale render behind (#766).
    const flush = async (): Promise<void> => {
        while (pending || inFlight) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (pending) {
                await writeNext();
            } else {
                // A write is already in flight; wait for it to settle and
                // re-check — it may have left a newer payload behind.
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

    return { schedule, flush, reset };
};

const jsonBackupCoalescer = createCoalescingWriter<AppData, { sizeChars: number; skipped: boolean }>({
    coalesceMs: JSON_BACKUP_COALESCE_MS,
    minIntervalMs: JSON_BACKUP_MIN_INTERVAL_MS,
    mergeMinimumUpdatedAtMs: (prevMs, nextMs) => Math.max(prevMs, nextMs),
    write: (pending) => saveStartupJsonBackup(AsyncStorage, pending.data, pending.phasePrefix, pending.minimumUpdatedAtMs),
    onSlow: (elapsedMs, pending, result) => {
        logStorageInfo('[Storage] Slow post-save backup', {
            jsonBackupMs: String(elapsedMs),
            // AsyncStorage on Android cannot read a row back past the
            // ~2MB CursorWindow limit; the size tells a shared log
            // whether this backup is usable as a fallback at all.
            sizeChars: String(result.sizeChars),
            skipped: String(result.skipped),
            coalescedSaves: String(pending.coalescedCount),
        });
    },
    onTimerError: (error) => {
        logStorageWarn('[Storage] Deferred JSON backup failed', error);
    },
});

// Only for the paths where the JSON copy IS the durable one (SQLite write
// failed). An oversized library writes no backup, so the save must fail loudly
// instead of reporting success with nothing persisted anywhere (#766).
const assertJsonFallbackLanded = (): void => {
    if (isJsonBackupUsable()) return;
    throw new Error('SQLite is unavailable and the library is too large for the JSON backup, so this change could not be saved.');
};

const flushPendingStartupJsonBackup = (): Promise<void> => jsonBackupCoalescer.flush();

const isAppForegroundActive = (): boolean => (
    Platform.OS !== 'web'
    && (AppState as unknown as { currentState?: string } | undefined)?.currentState === 'active'
);

// Widget renders use the same foreground throttle shape as the JSON backup,
// but flush as soon as the app leaves the foreground and the widget becomes
// visible. Hosts without AppState keep the short trailing coalesce.
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

// Keeps the AsyncStorage copy near-fresh for the pre-1.1.5 downgrade path and
// for process death after backgrounding, without waiting out the throttle
// window while the app stays foregrounded and busy (#766). Feature-detected
// because AppState isn't available in every host environment (vitest/jsdom
// have no native AppState module) — this must not crash module load there.
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
    if (backupVersion !== STARTUP_BACKUP_VERSION) {
        return null;
    }
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

// 1.1.5-rc.1 shipped with a broken exec splitter, so SQLite init failed and every
// save on that build landed only in the AsyncStorage JSON backup. Once SQLite works
// again it holds pre-rc.1 data and the normal "migrate only into an empty DB" path
// would silently drop everything written on rc.1. Recover by merging the backup into
// SQLite once, through the same revision-aware merge sync uses (idempotent, LWW,
// tombstone-safe). Never blocks startup: any failure is logged and retried next launch.
const SQLITE_JSON_RECONCILE_KEY = `${DATA_KEY}:sqlite-json-reconcile-v1`;

const reconcileJsonBackupIntoSqlite = async (
    adapter: SqliteAdapter,
    currentSnapshot?: AppData,
): Promise<void> => {
    if (await AsyncStorage.getItem(SQLITE_JSON_RECONCILE_KEY) != null) return;
    const backupVersion = await AsyncStorage.getItem(STARTUP_BACKUP_VERSION_KEY);
    if (backupVersion !== STARTUP_BACKUP_VERSION) {
        // Only merge a backup maintained by the current SQLite bridge. An old,
        // unmarked legacy snapshot may be stale and must not reintroduce entities
        // after SQLite has already become the primary store.
        await AsyncStorage.setItem(SQLITE_JSON_RECONCILE_KEY, '1');
        return;
    }
    let jsonValue: string | null = null;
    try {
        jsonValue = await getLegacyJson(AsyncStorage);
    } catch (error) {
        // Oversized backups (> Android's 2MB CursorWindow) are unreadable; there is
        // nothing to recover from them, so don't fail init and don't mark done.
        logStorageWarn('[Storage] Skipped JSON backup reconcile; backup unreadable', error);
        return;
    }
    if (jsonValue != null) {
        let backup: AppData;
        try {
            backup = parseStoredAppDataJson(jsonValue);
        } catch (error) {
            // A corrupt backup has nothing to recover; don't re-parse it every launch.
            logStorageWarn('[Storage] Skipped JSON backup reconcile; backup did not parse', error);
            await AsyncStorage.setItem(SQLITE_JSON_RECONCILE_KEY, '1');
            return;
        }
        const current = currentSnapshot ?? await adapter.getData();
        const { data: merged, stats } = mergeAppDataWithStats(current, backup);
        await adapter.saveData(merged);
        logStorageInfo('[Storage] Reconciled JSON backup into SQLite', {
            backupTasks: String(backup.tasks.length),
            sqliteTasks: String(current.tasks.length),
            mergedTasks: String(merged.tasks.length),
            tasksFromBackup: String((stats.tasks?.incomingOnly ?? 0) + (stats.tasks?.resolvedUsingIncoming ?? 0)),
        });
    }
    await AsyncStorage.setItem(SQLITE_JSON_RECONCILE_KEY, '1');
};

/**
 * Merge writes the JSON backup took while SQLite was refusing them (#964).
 *
 * Unlike the one-time reconcile above this runs whenever the marker is set, and
 * a failed recovery write is NOT swallowed: it fails init on purpose, so this
 * session reads the JSON copy instead of the database that is missing those
 * writes. A transient backup read failure keeps SQLite available for stale
 * reads, but quarantines every AppData write until recovery can be retried.
 * Without that, SQLite keeps reading fine, the fallback keeps taking writes
 * nothing reads back, and every restart looks like the app rolled back to the
 * last state SQLite accepted.
 */
const recoverJsonAheadWrites = async (adapter: SqliteAdapter, currentSnapshot?: AppData): Promise<boolean> => {
    let jsonValue: string | null;
    try {
        jsonValue = await getLegacyJson(AsyncStorage);
    } catch (error) {
        if (isPermanentJsonBackupReadError(error)) {
            // Android's CursorWindow limit means nothing will ever read this row
            // back; keeping the marker would fail init on every launch from here on.
            logStorageWarn('[Storage] JSON-ahead backup is permanently unreadable; abandoning recovery', error);
            await clearJsonAheadOfSqlite();
            return false;
        }
        // Transient (AsyncStorage hiccup, etc.): the pending writes may still be
        // recoverable, so keep the marker and signal init to retain this adapter
        // for stale reads only. Writes stay quarantined until a later init can
        // read and recover the backup.
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
        // Corrupt: there is nothing to recover, and keeping the marker would fail
        // init on every launch from here on.
        logStorageWarn('[Storage] JSON-ahead backup is corrupt; abandoning recovery', error);
        await clearJsonAheadOfSqlite();
        return false;
    }
    const current = currentSnapshot ?? await adapter.getData();
    const { data: merged, stats } = mergeAppDataWithStats(current, backup);
    await adapter.saveData(merged);
    await clearJsonAheadOfSqlite();
    logStorageInfo('[Storage] Recovered JSON-only writes into SQLite', {
        backupTasks: String(backup.tasks.length),
        sqliteTasks: String(current.tasks.length),
        mergedTasks: String(merged.tasks.length),
        tasksFromBackup: String((stats.tasks?.incomingOnly ?? 0) + (stats.tasks?.resolvedUsingIncoming ?? 0)),
    });
    return true;
};

const prepareSqliteData = async (adapter: SqliteAdapter, client: SqliteClient): Promise<boolean> => {
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
        // A failed count means unknown, never empty. If the full read still works,
        // use that authoritative snapshot to classify and reconcile safely.
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
            logStorageWarn('[Storage] Failed to reconcile JSON backup into SQLite', error);
        }
        return recoveredJsonAhead;
    }

    const jsonValue = await measureStartupPhase('mobile.storage.sqlite_init.read_legacy_json', async () =>
        getLegacyJson(AsyncStorage)
    );
    if (jsonValue == null) return recoveredJsonAhead;
    try {
        const backup = parseStoredAppDataJson(jsonValue);
        // Re-read after the emptiness probe and merge even on first migration.
        // A second process may have inserted rows between the two operations;
        // promoting the JSON snapshot directly would make those rows omissions.
        const current = readableSnapshot ?? await adapter.getData();
        const { data: merged } = mergeAppDataWithStats(current, backup);
        // Ensure fallback stays consistent before attempting the SQLite write.
        await saveStartupJsonBackup(AsyncStorage, merged, 'mobile.storage.sqlite_init.migrate');
        await measureStartupPhase('mobile.storage.sqlite_init.migrate_json_to_sqlite', async () =>
            adapter.saveData(merged)
        );
        await AsyncStorage.setItem(SQLITE_JSON_RECONCILE_KEY, '1');
    } catch (error) {
        logStorageWarn('[Storage] Failed to migrate JSON data to SQLite', error);
    }
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
    // Diagnostic: confirm whether WAL actually took effect on this device. Init runs
    // during the getData that loads the settings which enable diagnostic logging, so a
    // log line written here is dropped — capture the values and attach them to the
    // slow-save/read-wait logs that fire later instead.
    try {
        const journalRow = await client.get<{ journal_mode?: string }>('PRAGMA journal_mode');
        const busyRow = await client.get<{ timeout?: number }>('PRAGMA busy_timeout');
        // 2 = MEMORY. Anything else means a spilled statement journal will look for a
        // temp directory Android does not have and fail the write (#964).
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

// Platform-specific storage implementation
const createStorage = (): StorageAdapter => {
    // Web platform - use localStorage
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
    const sqliteUnavailableReason = getSqliteUnavailableReason();
    const shouldUseSqlite = sqliteUnavailableReason == null;
    registerBackgroundFlushListener();

    return {
        getData: async (): Promise<AppData> => {
            markStartupPhase('mobile.storage.get_data.start');
            // allowEmptyOnAbsent: the SQLite-genuinely-failed callers (json_fast_path,
            // json_preferred_sqlite_disabled, get_data_fallback) have always treated an
            // absent backup as a fresh install. The json_ahead caller must not: SQLite
            // is healthy there, so an absent backup means "nothing to serve from this
            // path", not "empty library" — the caller falls through to the SQLite read
            // instead (#975).
            const loadJsonBackup = async (phase = 'get_data', allowEmptyOnAbsent = true) => {
                // A deferred backup may still be pending; land it before trusting
                // the stored copy (and before the freshness assert reads its stamp).
                await flushPendingStartupJsonBackup();
                if (!isJsonBackupUsable()) {
                    // Reading it would spend seconds only to throw "Row too big";
                    // whatever is on disk predates the writes SQLite has taken since.
                    logStorageWarn('[Storage] Refusing oversized JSON backup fallback', undefined, { phase });
                    throw new Error('The library is too large for the local JSON backup; SQLite is the only readable copy.');
                }
                await assertJsonBackupFreshEnough(AsyncStorage, phase);
                const jsonValue = await getLegacyJson(AsyncStorage);
                if (jsonValue == null) {
                    if (!allowEmptyOnAbsent) {
                        throw new Error('JSON backup is absent; nothing to serve from the json-ahead path.');
                    }
                    return { ...EMPTY_APP_DATA };
                }
                if (jsonValue != null) {
                    try {
                        const data = parseStoredAppDataJson(jsonValue);
                        // Scheduled rather than detached so quiesceMobileStorage can
                        // land it: a bare .catch() chain keeps running after a headless
                        // task returns, which is exactly when the runtime goes away.
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
            // The JSON backup holds writes SQLite hasn't taken yet (#975): serve it
            // instead of a known-stale SQLite read, and touch no marker here — only
            // saveData may clear jsonAheadOfSqlite (#964).
            if (jsonAheadOfSqlite && isJsonBackupUsable()) {
                try {
                    return await loadJsonBackup('json_ahead', false);
                } catch (error) {
                    logStorageWarn('[Storage] Failed to load the JSON-ahead backup; falling back to SQLite read', error);
                }
            }
            try {
                if (!shouldUseSqlite) {
                    throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                }
                // Fail fast only when the JSON backup can actually catch us.
                const hasJsonFallback = isJsonBackupUsable();
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
                    // readTimeoutMs distinguishes the no-fallback long bound in shared
                    // logs; readMs above the 3.5s fail-fast cap = a sync cycle this
                    // fix saved (#766 next-round marker).
                    logStorageInfo('[Storage] Slow SQLite load', {
                        readMs: String(readMs),
                        readTimeoutMs: String(readTimeoutMs),
                        ...(sqliteJournalDiagnostics ?? {}),
                    });
                }
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                // Only the exact object returned by a healthy SQLite read can
                // later prove that the foreground store replaced its stale copy.
                // Background reads alone never release the recovery barrier.
                if (!state.writeBlockedReason && canonicalReloadRequired) {
                    canonicalReloadCandidates.add(data);
                }
                if (!jsonAheadOfSqlite) {
                    // While the marker is set the JSON backup is ahead of this SQLite
                    // read; scheduling a backup here would overwrite the fresher copy
                    // with stale data (#975).
                    scheduleStartupJsonBackup(data, 'mobile.storage.get_data', latestQueuedWriteStartedAtMs);
                }
                markStartupPhase('mobile.storage.get_data.widget_update_dispatched');
                clearPreferJsonBackup();
                markStartupPhase('mobile.storage.get_data.end');
                const archiveMetadataRows = data.tasks.length + data.sections.length;
                if (archiveMetadataRows > 0) {
                    logStorageInfo('SQLite project archive metadata loaded in canonical form', {
                        releaseCheck: 'v1.2.8/archive-metadata-canonical',
                        count: String(archiveMetadataRows),
                    });
                }
                return data;
            } catch (e) {
                if (!isJsonBackupUsable()) {
                    // There is no readable fallback, so pinning reads to it would
                    // only stall every read for the whole cooldown and fail the
                    // sync cycle waiting behind it. Surface the SQLite failure and
                    // let the next read retry SQLite instead (#766).
                    logStorageWarn('[Storage] SQLite load failed and the JSON backup is oversized; retrying SQLite next read', e);
                    markStartupPhase('mobile.storage.get_data.error');
                    throw e;
                }
                if (__DEV__ && sqliteUnavailableReason) {
                    logStorageWarn(`[Storage] ${sqliteUnavailableReason}; falling back to JSON backup`);
                } else {
                    logStorageWarn('[Storage] SQLite load failed, falling back to JSON backup', e);
                }
                markPreferJsonBackup();
                const fallbackData = await measureStartupPhase('mobile.storage.get_data.json_fallback_read', async () => loadJsonBackup('get_data_fallback'));
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
                const queuedWriteStartedAtMs = markQueuedWriteStarted();
                try {
                    if (!shouldUseSqlite) {
                        throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                    }
                    const state = await measureStartupPhase('mobile.storage.save_data.sqlite_get_state', async () => getSqliteState());
                    assertSqliteWritesAllowed(state, reloadRequiredWhenEnqueued);
                    const { adapter } = state;
                    // Sample JS-thread congestion alongside the write: a setTimeout(0)
                    // that resolves late means the thread is starved, which inflates every
                    // awaited SQL statement (large beginMs) without SQLite being at fault.
                    // Not awaited, so it never delays the write; it has always resolved by
                    // the time a save is slow enough to hit the log threshold.
                    let eventLoopLagMs = -1;
                    const lagProbeStartedAt = Date.now();
                    setTimeout(() => {
                        eventLoopLagMs = Date.now() - lagProbeStartedAt;
                    }, 0);
                    const writeStartedAt = Date.now();
                    await measureStartupPhase('mobile.storage.save_data.sqlite_write', async () => adapter.saveData(data));
                    const writeMs = Date.now() - writeStartedAt;
                    // A large-share rewrite logs even when the write is fast:
                    // a sync-rewrite loop (#766) must stay visible in user logs
                    // once hardware or fixes make the writes cheap, and the
                    // diagnostic names the oscillating columns.
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
                    // A full snapshot just landed, so SQLite is no longer behind the
                    // JSON copy. Only saveData may clear this — saveTask writes one
                    // row and cannot vouch for earlier JSON-only writes (#964).
                    await clearJsonAheadOfSqlite();
                    // SQLite is the durable copy; the JSON backup and widget render
                    // land coalesced off the save queue so reads and following taps
                    // never wait on them (#766).
                    scheduleStartupJsonBackup(data, 'mobile.storage.save_data', queuedWriteStartedAtMs);
                    markStartupPhase('mobile.storage.save_data.end');
                } catch (error) {
                    if (error instanceof SqliteWriteBlockedError) {
                        markStartupPhase('mobile.storage.save_data.write_quarantined');
                        throw error;
                    }
                    markPreferJsonBackup();
                    if (__DEV__ && sqliteUnavailableReason) {
                        logStorageWarn(`[Storage] ${sqliteUnavailableReason}; keeping JSON backup`);
                    } else {
                        logStorageWarn('[Storage] SQLite save failed, keeping JSON backup', error);
                    }
                    try {
                        // Persist the recovery intent first: if the process dies
                        // after the backup lands, the next launch must not serve
                        // stale SQLite rows (#964).
                        await markJsonAheadOfSqlite();
                        // With SQLite down the JSON backup IS the durable copy; it
                        // must land before this save reports success.
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
                const queuedWriteStartedAtMs = markQueuedWriteStarted();
                try {
                    if (!shouldUseSqlite) {
                        throw new Error(sqliteUnavailableReason ?? 'SQLite unavailable');
                    }
                    const state = await measureStartupPhase('mobile.storage.save_task.sqlite_get_state', async () => getSqliteState());
                    assertSqliteWritesAllowed(state, reloadRequiredWhenEnqueued);
                    const { adapter } = state;
                    // Same unawaited probe as saveData: a single-row write taking
                    // seconds is either queued behind another save or starved by the
                    // JS thread, and writeMs alone cannot tell those apart (#766).
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
                    markPreferJsonBackup();
                    logStorageWarn('[Storage] SQLite task save failed', error);
                    if (!snapshot) {
                        throw error;
                    }

                    try {
                        await markJsonAheadOfSqlite();
                        // With SQLite down the JSON backup IS the durable copy; it
                        // must land before this save reports success.
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
            // A direct adapter.queryTasks() call below would read SQLite's known-stale
            // rows straight from SQL, bypassing getData()'s read-authority guard.
            if (jsonIsReadAuthority()) {
                if (shouldUseJsonBackupFastPath()) {
                    warnPreferJsonBackup();
                }
                const data = await mobileStorage.getData();
                return data.tasks.filter((task) => taskMatchesQuery(task, options));
            }
            try {
                await awaitQueuedSqliteWrites('query_tasks');
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

// Headless RN instances (background sync, context automation) are destroyed as soon
// as their task promise settles, and op-sqlite resolves async results back onto the
// JS runtime. A write still in flight at that moment writes into a freed Hermes heap
// and takes the process down with a native SIGSEGV — the crash was reproducible as
// libhermes <- libop-sqlite <- Task::execute on an mqt_js thread.
//
// Every headless entry point must call this before it returns. Order matters: a
// SQLite write re-arms the JSON/widget timers when it completes, so the write queue
// has to drain first or the flushes below leave freshly-armed work behind.
export const quiesceMobileStorage = async (): Promise<void> => {
    try {
        await waitForQueuedSqliteWrites();
        await flushPendingStartupJsonBackup();
        await flushPendingWidgetRefresh();
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

// MARK: - Calendar Sync SQLite helpers

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
