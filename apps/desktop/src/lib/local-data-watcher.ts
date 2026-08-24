import {
    type AppData,
    flushPendingSave,
    getStorageAdapter,
    getInMemoryAppDataSnapshot,
    mergeAppData,
    normalizeAppData,
    runSerializedSyncDocumentWriteOperation,
    useTaskStore,
} from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';
import { getDesktopTimerHost, isTauriRuntime } from './runtime';
import { hashString, toStableJson } from './sync-service-utils';
import { logInfo, logWarn } from './app-log';

const IGNORE_WINDOW_MS = 2000;
const DEBOUNCE_MS = 750;
const IGNORE_DRAIN_PADDING_MS = 25;
const SQLITE_NOOP_REFRESH_IGNORE_MS = 2000;
const SQLITE_SELF_WRITE_RETENTION_MS = 15_000;
const SELF_WRITE_RETENTION_MS = 10_000;
const MAX_PENDING_SELF_WRITES = 8;
const MAX_MERGED_PERSIST_ATTEMPTS = 2;
const MAX_DELAYED_MERGED_PERSIST_RETRIES = 2;
const MERGED_PERSIST_RETRY_COOLDOWN_MS = 1_000;
const MAX_DELAYED_SQLITE_REFRESH_RETRIES = 2;
const SQLITE_REFRESH_RETRY_COOLDOWN_MS = 1_000;
const MAX_WATCH_REGISTRATION_RETRIES = 2;
const WATCH_REGISTRATION_RETRY_COOLDOWN_MS = 1_000;
const timerHost = getDesktopTimerHost();

type FsEvent = {
    path?: string;
    paths?: string[];
};

export type LocalDataWatcherDependencies = {
    readDataJson: () => Promise<AppData>;
    /** Read-only storage snapshot for the pre-apply no-op check — never applies
     *  anything to the store. */
    readStorageSnapshot: () => Promise<AppData>;
    refreshStorageData: (isResultStillRelevant?: () => boolean) => Promise<void>;
    watchFile: (path: string, callback: (event: FsEvent) => void) => Promise<unknown>;
    now: () => number;
    schedule: typeof setTimeout;
    cancelSchedule: typeof clearTimeout;
    hashPayload: (payload: string) => Promise<string>;
    normalize: (data: AppData) => AppData;
    merge: (local: AppData, incoming: AppData) => AppData;
    getSnapshot: () => AppData;
    getEditLockCount: () => number;
    subscribeStore: (listener: () => void) => () => void;
    persistMergedData: (
        merged: AppData,
        isResultStillRelevant?: () => boolean,
    ) => Promise<AppData | void>;
    logInfo: (message: string, extra?: Record<string, unknown>) => void;
    logWarn: (message: string, extra?: Record<string, unknown>) => void;
};

const persistMergedDataThroughStore = async (
    merged: AppData,
    now: () => number,
    isResultStillRelevant: () => boolean = () => true,
): Promise<AppData> => {
    const persisted = await getStorageAdapter().saveData(merged);
    const canonical = persisted ?? merged;
    if (!isResultStillRelevant()) return canonical;
    const allTasks = Array.isArray(canonical.tasks) ? canonical.tasks : [];
    const allProjects = Array.isArray(canonical.projects) ? canonical.projects : [];
    const allSections = Array.isArray(canonical.sections) ? canonical.sections : [];
    const allAreas = Array.isArray(canonical.areas) ? canonical.areas : [];
    const allPeople = Array.isArray(canonical.people) ? canonical.people : [];

    useTaskStore.setState((state) => ({
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        _allPeople: allPeople,
        settings: canonical.settings ?? state.settings,
        lastDataChangeAt: Math.max(now(), state.lastDataChangeAt + 1),
    }));
    return canonical;
};

const createDefaultDependencies = (now: () => number): LocalDataWatcherDependencies => ({
    readDataJson: () => invokeNative<AppData>('read_data_json'),
    readStorageSnapshot: () => invokeNative<AppData>('get_data'),
    refreshStorageData: async (isResultStillRelevant) => {
        await useTaskStore.getState().fetchData({
            silent: true,
            throwOnError: true,
            isResultStillRelevant,
        });
    },
    watchFile: async (path, callback) => {
        const { watch } = await import('@tauri-apps/plugin-fs');
        return watch(path, callback);
    },
    now: () => Date.now(),
    schedule: timerHost.setTimeout,
    cancelSchedule: timerHost.clearTimeout,
    hashPayload: hashString,
    normalize: normalizeAppData,
    merge: mergeAppData,
    getSnapshot: getInMemoryAppDataSnapshot,
    getEditLockCount: () => useTaskStore.getState().editLockCount,
    subscribeStore: (listener) => useTaskStore.subscribe(() => listener()),
    persistMergedData: (merged, isResultStillRelevant) => (
        persistMergedDataThroughStore(merged, now, isResultStillRelevant)
    ),
    logInfo: (message, extra) => {
        void logInfo(message, extra ? { extra } : undefined);
    },
    logWarn: (message, extra) => {
        void logWarn(message, extra ? { extra } : undefined);
    },
});

type LocalDataWatcherTestUtils = {
    setDependenciesForTests: (overrides: Partial<LocalDataWatcherDependencies>) => void;
    triggerChangeForTests: () => Promise<void>;
    triggerSqliteChangeForTests: () => Promise<void>;
    refreshFromDiskNowForTests: () => Promise<void>;
    waitForPendingMergeForTests: () => Promise<void>;
    waitForPendingSqliteRefreshForTests: () => Promise<void>;
    resetForTests: () => void;
    getPendingSelfWritePayloadLengthForTests: () => number;
};

export type LocalDataWatcherController = {
    refreshFromDiskNow: () => Promise<void>;
    rearmExhaustedWatchers: () => void;
    markLocalWrite: (data?: AppData) => void;
    markLocalSqliteWrite: () => void;
    start: (dataPath: string, dbPath?: string) => Promise<void>;
    stop: () => void;
    testUtils: LocalDataWatcherTestUtils;
};

export const createLocalDataWatcherController = (
    overrides: Partial<LocalDataWatcherDependencies> = {},
): LocalDataWatcherController => {
    let localDataWatcherDependencies: LocalDataWatcherDependencies;
    const controllerNow = () => localDataWatcherDependencies?.now() ?? Date.now();
    const resetDependencies = () => {
        localDataWatcherDependencies = {
            ...createDefaultDependencies(controllerNow),
            ...overrides,
        };
    };
    resetDependencies();

    type WatchChannelState = {
        path: string | null;
        callback: ((event: FsEvent) => void) | null;
        startedMessage: string;
        failedMessage: string;
        unwatch: (() => void) | null;
        registration: Promise<void> | null;
        retryTimer: ReturnType<typeof setTimeout> | null;
        retryCount: number;
    };

    const createWatchChannelState = (): WatchChannelState => ({
        path: null,
        callback: null,
        startedMessage: '',
        failedMessage: '',
        unwatch: null,
        registration: null,
        retryTimer: null,
        retryCount: 0,
    });

    let dataWatchChannel = createWatchChannelState();
    let sqliteWatchChannel = createWatchChannelState();
    let ignoreUntil = 0;
    let sqliteIgnoreUntil = 0;
    let sqliteSelfWriteUntil = 0;
    let lastSqliteSelfWriteAt = 0;
    let sqliteSuppressedSelfWriteEvents = 0;
    let lastKnownHash = '';
    let pendingSelfWrites: Array<{ payload: string; expiresAt: number }> = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let sqliteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let ignoreDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let sqliteIgnoreDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let hasPendingChangeDuringIgnore = false;
    let hasPendingSqliteChangeDuringSelfWrite = false;
    let pendingSqliteChangePaths: string[] = [];
    let pendingExternalChange = false;
    // Set by stop() when it drops a real pending change (StrictMode/HMR/
    // teardown mid-debounce); consumed by the next start() to recover it.
    // Ordinary first-start at launch never sets this, so start() doesn't run
    // a merge against a still-unhydrated store.
    let droppedPendingChangeAtStop = false;
    let mergeInFlight: Promise<void> | null = null;
    let mergeInFlightGeneration: number | null = null;
    let sqliteRefreshInFlight: Promise<void> | null = null;
    let sqliteRefreshInFlightGeneration: number | null = null;
    let mergedPersistRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let delayedMergedPersistRetryCount = 0;
    let sqliteRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let delayedSqliteRefreshRetryCount = 0;
    let watcherGeneration = 0;
    let sqliteEditUnlockUnsubscribe: (() => void) | null = null;

    const isCurrentWatcherGeneration = (generation: number): boolean => generation === watcherGeneration;

    const normalizePathsFromEvent = (event: FsEvent): string[] => {
        if (Array.isArray(event?.paths)) return event.paths;
        if (typeof event?.path === 'string' && event.path.length > 0) return [event.path];
        return [];
    };

    const getPathBasename = (path: string): string => {
        const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
    };

    const getParentPath = (path: string): string | null => {
        const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (separatorIndex <= 0) return null;
        return path.slice(0, separatorIndex);
    };

    const formatPathsForTrace = (paths: string[]): string => paths.map(getPathBasename).slice(0, 8).join(',');

    const remainingMs = (until: number, now: number): string => String(Math.max(0, Math.ceil(until - now)));

    const buildSqliteWatcherTraceExtra = (
        paths: string[] = [],
        extra: Record<string, unknown> = {},
    ): Record<string, unknown> => {
        const now = localDataWatcherDependencies.now();
        return {
            ...extra,
            basenames: formatPathsForTrace(paths),
            pathCount: String(paths.length),
            nowMs: String(now),
            ignoreRemainingMs: remainingMs(sqliteIgnoreUntil, now),
            selfWriteRemainingMs: remainingMs(sqliteSelfWriteUntil, now),
            sinceSelfWriteMs: lastSqliteSelfWriteAt > 0 ? String(now - lastSqliteSelfWriteAt) : '',
            refreshInFlight: String(Boolean(sqliteRefreshInFlight)),
            debounceActive: String(Boolean(sqliteDebounceTimer)),
            suppressedSelfWriteEvents: String(sqliteSuppressedSelfWriteEvents),
        };
    };

    type SnapshotTraceSummary = {
        dataSig: string;
        /**
         * Per-collection signatures are diagnostics only and are absent unless
         * logging is enabled — see the gate in `buildSnapshotTraceSummary`.
         */
        tasksSig?: string;
        projectsSig?: string;
        sectionsSig?: string;
        areasSig?: string;
        peopleSig?: string;
        settingsSig?: string;
        taskCount: string;
        projectCount: string;
        sectionCount: string;
        areaCount: string;
        peopleCount: string;
    };

    const buildSnapshotTraceSummary = async (data: AppData): Promise<SnapshotTraceSummary> => {
        const normalized = stripSqliteRefreshBookkeeping(localDataWatcherDependencies.normalize(data));
        const tasks = Array.isArray(normalized.tasks) ? normalized.tasks : [];
        const projects = Array.isArray(normalized.projects) ? normalized.projects : [];
        const sections = Array.isArray(normalized.sections) ? normalized.sections : [];
        const areas = Array.isArray(normalized.areas) ? normalized.areas : [];
        const people = Array.isArray(normalized.people) ? (normalized.people ?? []) : [];
        const settings = normalized.settings ?? {};
        // `dataSig` drives the no-op refresh detection in `runSqliteRefresh`, so it
        // is always computed. The six per-collection signatures are for logging
        // only, and each one costs another full stable-stringify of that
        // collection — on a large store that is megabytes of transient string per
        // refresh, twice per refresh. Gate them behind the same logging switch
        // `sync-service.ts` uses for its payload traces.
        const detailed = normalized.settings?.diagnostics?.loggingEnabled === true;
        const dataSig = await localDataWatcherDependencies.hashPayload(toStableJson(normalized));
        const [tasksSig, projectsSig, sectionsSig, areasSig, peopleSig, settingsSig] = detailed
            ? await Promise.all([
                  localDataWatcherDependencies.hashPayload(toStableJson(tasks)),
                  localDataWatcherDependencies.hashPayload(toStableJson(projects)),
                  localDataWatcherDependencies.hashPayload(toStableJson(sections)),
                  localDataWatcherDependencies.hashPayload(toStableJson(areas)),
                  localDataWatcherDependencies.hashPayload(toStableJson(people)),
                  localDataWatcherDependencies.hashPayload(toStableJson(settings)),
              ])
            : [undefined, undefined, undefined, undefined, undefined, undefined];

        return {
            dataSig,
            tasksSig,
            projectsSig,
            sectionsSig,
            areasSig,
            peopleSig,
            settingsSig,
            taskCount: String(tasks.length),
            projectCount: String(projects.length),
            sectionCount: String(sections.length),
            areaCount: String(areas.length),
            peopleCount: String(people.length),
        };
    };

    const prefixSnapshotTraceSummary = (prefix: string, summary: SnapshotTraceSummary): Record<string, string> =>
        Object.fromEntries(
            Object.entries(summary)
                // An absent per-collection signature means logging was off when the
                // summary was built; omit it rather than reporting an empty digest.
                .filter(([, value]) => value !== undefined)
                .map(([name, value]) => [`${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`, value as string]),
        );

    /** Reports a change only when both signatures were actually computed. */
    const changed = (name: string, before: string | undefined, after: string | undefined): Record<string, string> =>
        before === undefined || after === undefined ? {} : { [name]: String(before !== after) };

    const buildSnapshotChangeTraceExtra = (
        before: SnapshotTraceSummary,
        after: SnapshotTraceSummary,
    ): Record<string, string> => {
        return {
            dataChanged: String(before.dataSig !== after.dataSig),
            ...changed('tasksChanged', before.tasksSig, after.tasksSig),
            ...changed('projectsChanged', before.projectsSig, after.projectsSig),
            ...changed('sectionsChanged', before.sectionsSig, after.sectionsSig),
            ...changed('areasChanged', before.areasSig, after.areasSig),
            ...changed('peopleChanged', before.peopleSig, after.peopleSig),
            ...changed('settingsChanged', before.settingsSig, after.settingsSig),
            ...prefixSnapshotTraceSummary('before', before),
            ...prefixSnapshotTraceSummary('after', after),
        };
    };

    /** Filter out iCloud placeholder events (.icloud files, lock files). */
    const isRelevantSyncEvent = (paths: string[]): boolean => {
        return paths.some((p) => {
            const name = getPathBasename(p);
            // Ignore iCloud placeholder stubs (.filename.icloud)
            if (name.endsWith('.icloud')) return false;
            // Ignore our own advisory lock file
            if (name === '.mindwtr.lock') return false;
            // Ignore temp files from atomic writes
            if (name.endsWith('.tmp')) return false;
            return true;
        });
    };

    const isRelevantSqliteEvent = (paths: string[], dbPath: string): boolean => {
        const dbName = getPathBasename(dbPath);
        // WAL carries committed writes. The shared-memory file can move during
        // read/lock activity, so watching it makes fetchData feed itself.
        const sqliteNames = new Set([dbName, `${dbName}-wal`]);
        return paths.some((path) => sqliteNames.has(getPathBasename(path)));
    };

    const resolveUnwatch = (unwatch: unknown): (() => void) | null => {
        if (typeof unwatch === 'function') return unwatch as () => void;
        if (unwatch && typeof (unwatch as any).stop === 'function') {
            return () => (unwatch as any).stop();
        }
        if (unwatch && typeof (unwatch as any).unwatch === 'function') {
            return () => (unwatch as any).unwatch();
        }
        return null;
    };

    const pruneExpiredSelfWrites = (now: number) => {
        pendingSelfWrites = pendingSelfWrites.filter((entry) => entry.expiresAt > now);
    };

    const scheduleIgnoreDrain = () => {
        if (!hasPendingChangeDuringIgnore) return;
        const generation = watcherGeneration;
        if (ignoreDrainTimer) {
            const timer = ignoreDrainTimer;
            ignoreDrainTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel data ignore-drain timer');
        }
        const remainingMs = Math.max(0, ignoreUntil - localDataWatcherDependencies.now());
        ignoreDrainTimer = localDataWatcherDependencies.schedule(() => {
            if (!isCurrentWatcherGeneration(generation)) return;
            ignoreDrainTimer = null;
            if (!hasPendingChangeDuringIgnore) return;
            hasPendingChangeDuringIgnore = false;
            void handleExternalChange();
        }, remainingMs + IGNORE_DRAIN_PADDING_MS);
    };

    const scheduleSqliteIgnoreDrain = () => {
        if (!hasPendingSqliteChangeDuringSelfWrite) return;
        const generation = watcherGeneration;
        if (sqliteIgnoreDrainTimer) {
            const timer = sqliteIgnoreDrainTimer;
            sqliteIgnoreDrainTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel SQLite ignore-drain timer');
        }
        const drainAfter = Math.max(sqliteIgnoreUntil, sqliteSelfWriteUntil);
        const remainingMs = Math.max(0, drainAfter - localDataWatcherDependencies.now());
        sqliteIgnoreDrainTimer = localDataWatcherDependencies.schedule(() => {
            if (!isCurrentWatcherGeneration(generation)) return;
            sqliteIgnoreDrainTimer = null;
            if (!hasPendingSqliteChangeDuringSelfWrite) return;
            hasPendingSqliteChangeDuringSelfWrite = false;
            const paths = pendingSqliteChangePaths;
            pendingSqliteChangePaths = [];
            void handleSqliteChange({ immediate: true, paths });
        }, remainingMs + IGNORE_DRAIN_PADDING_MS);
    };

    const deferSqliteRefreshUntilEditingEnds = (
        paths: string[] = [],
        generation: number = watcherGeneration,
    ): void => {
        if (!isCurrentWatcherGeneration(generation)) return;
        hasPendingSqliteChangeDuringSelfWrite = true;
        pendingSqliteChangePaths = paths.slice(0, 8);
        if (sqliteEditUnlockUnsubscribe) return;

        const drainAfterUnlock = () => {
            if (!isCurrentWatcherGeneration(generation)) return;
            if (localDataWatcherDependencies.getEditLockCount() > 0) return;
            const unsubscribe = sqliteEditUnlockUnsubscribe;
            sqliteEditUnlockUnsubscribe = null;
            runWatcherCleanupSafely(unsubscribe, 'release edit-unlock subscription');
            if (!hasPendingSqliteChangeDuringSelfWrite) return;
            hasPendingSqliteChangeDuringSelfWrite = false;
            const pendingPaths = pendingSqliteChangePaths;
            pendingSqliteChangePaths = [];
            void handleSqliteChange({ immediate: true, paths: pendingPaths });
        };

        sqliteEditUnlockUnsubscribe = localDataWatcherDependencies.subscribeStore(drainAfterUnlock);
        // Close the subscribe-after-check race if the editor unlocked just before
        // the subscription became active.
        drainAfterUnlock();
    };

    const runPendingMerge = (generation: number = watcherGeneration): Promise<void> => {
        if (!isCurrentWatcherGeneration(generation)) return Promise.resolve();
        if (mergeInFlight) {
            const activeMerge = mergeInFlight;
            if (mergeInFlightGeneration === generation) return activeMerge;
            return activeMerge.then(async () => {
                if (isCurrentWatcherGeneration(generation) && pendingExternalChange) {
                    await runPendingMerge(generation);
                }
            });
        }

        const trackedMerge = (async () => {
            while (isCurrentWatcherGeneration(generation) && pendingExternalChange) {
                pendingExternalChange = false;
                await mergeExternalData(generation);
            }
        })().finally(() => {
            if (mergeInFlight === trackedMerge) {
                mergeInFlight = null;
                mergeInFlightGeneration = null;
            }
            if (isCurrentWatcherGeneration(generation) && pendingExternalChange) {
                void runPendingMerge(generation);
            }
        });
        mergeInFlight = trackedMerge;
        mergeInFlightGeneration = generation;

        return trackedMerge;
    };

    const stripSqliteRefreshBookkeeping = (data: AppData): AppData => {
        const {
            network,
            lastSyncAt,
            lastSyncStatus,
            lastSyncError,
            pendingRemoteWriteAt,
            pendingRemoteWriteRetryAt,
            pendingRemoteWriteAttempts,
            lastSyncStats,
            lastSyncHistory,
            ...settings
        } = data.settings ?? {};

        void network;
        void lastSyncAt;
        void lastSyncStatus;
        void lastSyncError;
        void pendingRemoteWriteAt;
        void pendingRemoteWriteRetryAt;
        void pendingRemoteWriteAttempts;
        void lastSyncStats;
        void lastSyncHistory;

        return {
            ...data,
            settings,
        };
    };

    const extendSqliteIgnoreWindow = (windowMs: number = IGNORE_WINDOW_MS): void => {
        sqliteIgnoreUntil = Math.max(sqliteIgnoreUntil, localDataWatcherDependencies.now() + windowMs);
    };

    const markSqliteSelfWriteWindow = (): void => {
        const now = localDataWatcherDependencies.now();
        extendSqliteIgnoreWindow();
        sqliteSelfWriteUntil = Math.max(sqliteSelfWriteUntil, now + SQLITE_SELF_WRITE_RETENTION_MS);
        lastSqliteSelfWriteAt = now;
        scheduleSqliteIgnoreDrain();
        localDataWatcherDependencies.logInfo(
            '[local-data-watcher] Marked SQLite self-write',
            buildSqliteWatcherTraceExtra([], {
                retentionMs: String(SQLITE_SELF_WRITE_RETENTION_MS),
            }),
        );
    };

    const isTerminalMergedPersistError = (error: unknown): boolean => {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return [
            'refusing to overwrite',
            'invalid app data',
            'invalid data snapshot',
            'unsupported data version',
            'validation failed',
        ].some((fragment) => message.includes(fragment));
    };

    const clearMergedPersistRetry = (): void => {
        if (mergedPersistRetryTimer) {
            const timer = mergedPersistRetryTimer;
            mergedPersistRetryTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel merged-persist retry timer');
        }
        delayedMergedPersistRetryCount = 0;
    };

    const scheduleMergedPersistRetry = (error: unknown): void => {
        if (isTerminalMergedPersistError(error)) {
            localDataWatcherDependencies.logWarn(
                '[local-data-watcher] Merged data persistence failed terminally; automatic retry disabled',
                { error: String(error) },
            );
            return;
        }
        if (mergedPersistRetryTimer || delayedMergedPersistRetryCount >= MAX_DELAYED_MERGED_PERSIST_RETRIES) {
            if (delayedMergedPersistRetryCount >= MAX_DELAYED_MERGED_PERSIST_RETRIES) {
                localDataWatcherDependencies.logWarn(
                    '[local-data-watcher] Merged data persistence exhausted delayed retries',
                    {
                        error: String(error),
                        maxRetries: String(MAX_DELAYED_MERGED_PERSIST_RETRIES),
                    },
                );
            }
            return;
        }

        delayedMergedPersistRetryCount += 1;
        const retryNumber = delayedMergedPersistRetryCount;
        const generation = watcherGeneration;
        const delayMs = MERGED_PERSIST_RETRY_COOLDOWN_MS * retryNumber;
        mergedPersistRetryTimer = localDataWatcherDependencies.schedule(() => {
            mergedPersistRetryTimer = null;
            if (generation !== watcherGeneration) return;
            pendingExternalChange = true;
            void runPendingMerge();
        }, delayMs);
        localDataWatcherDependencies.logWarn('[local-data-watcher] Scheduled merged data persistence retry', {
            retryNumber: String(retryNumber),
            delayMs: String(delayMs),
            error: String(error),
        });
    };

    const persistMergedDataWithRetry = async (
        merged: AppData,
        generation: number,
    ): Promise<AppData | null> => {
        for (let attempt = 1; attempt <= MAX_MERGED_PERSIST_ATTEMPTS; attempt += 1) {
            if (!isCurrentWatcherGeneration(generation)) return null;
            const pendingSelfWritesBeforeAttempt = pendingSelfWrites.slice();
            try {
                const canonical = (await localDataWatcherDependencies.persistMergedData(
                    merged,
                    () => isCurrentWatcherGeneration(generation),
                )) ?? merged;
                return isCurrentWatcherGeneration(generation) ? canonical : null;
            } catch (error) {
                if (!isCurrentWatcherGeneration(generation)) return null;
                // Storage adapters mark a payload before starting their durable
                // write. Restore the previous tokens when that write rejects so a
                // failed attempt cannot suppress the external snapshot that still
                // needs to be persisted.
                pendingSelfWrites = pendingSelfWritesBeforeAttempt;
                if (isTerminalMergedPersistError(error)) throw error;
                if (attempt === MAX_MERGED_PERSIST_ATTEMPTS) throw error;
                localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to persist merged data; retrying', {
                    attempt: String(attempt),
                    maxAttempts: String(MAX_MERGED_PERSIST_ATTEMPTS),
                });
            }
        }
        throw new Error('Merged data persistence exhausted without a result');
    };

    const clearSqliteRefreshRetry = (): void => {
        if (sqliteRefreshRetryTimer) {
            const timer = sqliteRefreshRetryTimer;
            sqliteRefreshRetryTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel SQLite refresh retry timer');
        }
        delayedSqliteRefreshRetryCount = 0;
    };

    const isTransientSqliteRefreshError = (error: unknown): boolean =>
        /\b(?:busy|locked|temporar(?:y|ily)|try again|resource unavailable)\b/iu.test(String(error));

    const scheduleSqliteRefreshRetry = (error: unknown): void => {
        if (!isTransientSqliteRefreshError(error)) return;
        if (sqliteRefreshRetryTimer || delayedSqliteRefreshRetryCount >= MAX_DELAYED_SQLITE_REFRESH_RETRIES) {
            if (delayedSqliteRefreshRetryCount >= MAX_DELAYED_SQLITE_REFRESH_RETRIES) {
                localDataWatcherDependencies.logWarn('[local-data-watcher] SQLite refresh exhausted delayed retries', {
                    error: String(error),
                    maxRetries: String(MAX_DELAYED_SQLITE_REFRESH_RETRIES),
                });
            }
            return;
        }
        delayedSqliteRefreshRetryCount += 1;
        const retryNumber = delayedSqliteRefreshRetryCount;
        const generation = watcherGeneration;
        const delayMs = SQLITE_REFRESH_RETRY_COOLDOWN_MS * retryNumber;
        sqliteRefreshRetryTimer = localDataWatcherDependencies.schedule(() => {
            sqliteRefreshRetryTimer = null;
            if (generation !== watcherGeneration) return;
            void runSqliteRefresh();
        }, delayMs);
        localDataWatcherDependencies.logWarn('[local-data-watcher] Scheduled SQLite refresh retry', {
            retryNumber: String(retryNumber),
            delayMs: String(delayMs),
            error: String(error),
        });
    };

    async function mergeExternalData(generation: number): Promise<void> {
        // Full-document sync, imports/restores, and this watcher all enter this
        // lane before reading their current inputs. A data transfer acquires its
        // store-write barrier only after it reaches the front of the same lane, so
        // the watcher never waits on that barrier while holding an earlier lock.
        await runSerializedSyncDocumentWriteOperation(async () => {
            if (!isCurrentWatcherGeneration(generation)) return;
            try {
                await flushPendingSave();
                if (!isCurrentWatcherGeneration(generation)) return;

                const rawData = await localDataWatcherDependencies.readDataJson();
                if (!isCurrentWatcherGeneration(generation)) return;
                const normalizedExternal = localDataWatcherDependencies.normalize(rawData);
                const externalPayload = toStableJson(normalizedExternal);

                const matchedSelfWriteIndex = pendingSelfWrites.findIndex((entry) => entry.payload === externalPayload);
                if (matchedSelfWriteIndex >= 0) {
                    const selfWriteHash = await localDataWatcherDependencies.hashPayload(externalPayload);
                    if (!isCurrentWatcherGeneration(generation)) return;
                    lastKnownHash = selfWriteHash;
                    pendingSelfWrites.splice(matchedSelfWriteIndex, 1);
                    clearMergedPersistRetry();
                    return;
                }

                const externalHash = await localDataWatcherDependencies.hashPayload(externalPayload);
                if (!isCurrentWatcherGeneration(generation)) return;
                if (externalHash === lastKnownHash) {
                    clearMergedPersistRetry();
                    return;
                }

                const localSnapshot = localDataWatcherDependencies.getSnapshot();
                const normalizedLocal = localDataWatcherDependencies.normalize(localSnapshot);
                const localPayload = toStableJson(normalizedLocal);
                const localHash = await localDataWatcherDependencies.hashPayload(localPayload);
                if (!isCurrentWatcherGeneration(generation)) return;

                if (localHash === externalHash) {
                    lastKnownHash = externalHash;
                    clearMergedPersistRetry();
                    return;
                }

                const merged = localDataWatcherDependencies.merge(normalizedLocal, normalizedExternal);
                const normalizedMerged = localDataWatcherDependencies.normalize(merged);
                const mergedPayload = toStableJson(normalizedMerged);
                const mergedHash = await localDataWatcherDependencies.hashPayload(mergedPayload);
                if (!isCurrentWatcherGeneration(generation)) return;

                if (mergedHash === localHash) {
                    lastKnownHash = mergedHash;
                    clearMergedPersistRetry();
                    return;
                }

                const canonical = await persistMergedDataWithRetry(normalizedMerged, generation);
                if (!canonical || !isCurrentWatcherGeneration(generation)) return;
                const canonicalHash = await localDataWatcherDependencies.hashPayload(
                    toStableJson(localDataWatcherDependencies.normalize(canonical)),
                );
                if (!isCurrentWatcherGeneration(generation)) return;
                lastKnownHash = canonicalHash;
                clearMergedPersistRetry();
                localDataWatcherDependencies.logInfo('[local-data-watcher] Merged external data.json changes');
            } catch (error) {
                if (!isCurrentWatcherGeneration(generation)) return;
                scheduleMergedPersistRetry(error);
                localDataWatcherDependencies.logWarn(
                    '[local-data-watcher] Failed to merge external data: ' + String(error),
                );
            }
        });
    }

    const runSqliteRefresh = (generation: number = watcherGeneration): Promise<void> => {
        if (!isCurrentWatcherGeneration(generation)) return Promise.resolve();
        if (sqliteRefreshInFlight) {
            const activeRefresh = sqliteRefreshInFlight;
            if (sqliteRefreshInFlightGeneration === generation) return activeRefresh;
            return activeRefresh.then(async () => {
                if (isCurrentWatcherGeneration(generation)) {
                    await runSqliteRefresh(generation);
                }
            });
        }

        const trackedRefresh = runSerializedSyncDocumentWriteOperation(async () => {
            if (!isCurrentWatcherGeneration(generation)) return;
            try {
                if (localDataWatcherDependencies.getEditLockCount() > 0) {
                    deferSqliteRefreshUntilEditingEnds([], generation);
                    return;
                }
                await flushPendingSave();
                if (!isCurrentWatcherGeneration(generation)) return;
                const beforeSummary = await buildSnapshotTraceSummary(localDataWatcherDependencies.getSnapshot());
                if (!isCurrentWatcherGeneration(generation)) return;
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite refresh start',
                    prefixSnapshotTraceSummary('before', beforeSummary),
                );
                // Compare BEFORE applying: fetchData replaces every store
                // object identity even when the content is byte-identical,
                // which re-rendered and re-measured the visible list — the
                // Inbox "flicker" of #1079 (launch, window restore, and the
                // sync self-write echoes this watcher chases). A read-only
                // snapshot costs less than the fetch it replaces. Fail open:
                // a failed probe falls through to the normal refresh.
                try {
                    const candidateSummary = await buildSnapshotTraceSummary(
                        await localDataWatcherDependencies.readStorageSnapshot(),
                    );
                    if (!isCurrentWatcherGeneration(generation)) return;
                    if (candidateSummary.dataSig === beforeSummary.dataSig) {
                        clearSqliteRefreshRetry();
                        extendSqliteIgnoreWindow(SQLITE_NOOP_REFRESH_IGNORE_MS);
                        localDataWatcherDependencies.logInfo(
                            '[local-data-watcher] SQLite refresh no data changes',
                            { comparedBeforeApply: 'true' },
                        );
                        return;
                    }
                } catch {
                    // Probe unavailable — refresh as before the probe existed.
                }
                if (!isCurrentWatcherGeneration(generation)) return;
                await localDataWatcherDependencies.refreshStorageData(
                    () => isCurrentWatcherGeneration(generation),
                );
                if (!isCurrentWatcherGeneration(generation)) return;
                const afterSummary = await buildSnapshotTraceSummary(localDataWatcherDependencies.getSnapshot());
                if (!isCurrentWatcherGeneration(generation)) return;
                clearSqliteRefreshRetry();
                const changeExtra = buildSnapshotChangeTraceExtra(beforeSummary, afterSummary);
                if (beforeSummary.dataSig === afterSummary.dataSig) {
                    extendSqliteIgnoreWindow(SQLITE_NOOP_REFRESH_IGNORE_MS);
                    localDataWatcherDependencies.logInfo(
                        '[local-data-watcher] SQLite refresh no data changes',
                        changeExtra,
                    );
                    return;
                }
                useTaskStore.setState((state) => ({
                    lastDataChangeAt: Math.max(localDataWatcherDependencies.now(), state.lastDataChangeAt + 1),
                }));
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite refresh changed snapshot',
                    changeExtra,
                );
                localDataWatcherDependencies.logInfo('[local-data-watcher] Refreshed after SQLite change');
            } catch (error) {
                if (!isCurrentWatcherGeneration(generation)) return;
                scheduleSqliteRefreshRetry(error);
                localDataWatcherDependencies.logWarn(
                    '[local-data-watcher] Failed to refresh SQLite change: ' + String(error),
                    { error: String(error) },
                );
            }
        }).finally(() => {
            if (sqliteRefreshInFlight === trackedRefresh) {
                sqliteRefreshInFlight = null;
                sqliteRefreshInFlightGeneration = null;
            }
        });
        sqliteRefreshInFlight = trackedRefresh;
        sqliteRefreshInFlightGeneration = generation;

        return trackedRefresh;
    };

    async function handleSqliteChange(options: { immediate?: boolean; paths?: string[] } = {}): Promise<void> {
        const generation = watcherGeneration;
        const paths = options.paths ?? [];
        const now = localDataWatcherDependencies.now();

        if (localDataWatcherDependencies.getEditLockCount() > 0) {
            deferSqliteRefreshUntilEditingEnds(paths, generation);
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite refresh deferred while an editor is open',
                buildSqliteWatcherTraceExtra(paths),
            );
            return;
        }

        if (!options.immediate) {
            // A distinct filesystem event represents a fresh opportunity to read
            // the database. Give it its own bounded retry allowance without
            // cancelling a retry that is already queued for the same lane.
            delayedSqliteRefreshRetryCount = 0;
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite event received',
                buildSqliteWatcherTraceExtra(paths),
            );

            if (now < sqliteIgnoreUntil) {
                if (now < sqliteSelfWriteUntil) {
                    sqliteSuppressedSelfWriteEvents += 1;
                }
                // The no-op window suppresses watcher feedback, but a WAL event can
                // also be a real concurrent writer. Coalesce every ignored event
                // and drain it once the active suppression window closes.
                hasPendingSqliteChangeDuringSelfWrite = true;
                pendingSqliteChangePaths = paths.slice(0, 8);
                scheduleSqliteIgnoreDrain();
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite event ignored inside write window',
                    buildSqliteWatcherTraceExtra(paths),
                );
                return;
            }

            if (now < sqliteSelfWriteUntil) {
                sqliteSuppressedSelfWriteEvents += 1;
                hasPendingSqliteChangeDuringSelfWrite = true;
                pendingSqliteChangePaths = paths.slice(0, 8);
                scheduleSqliteIgnoreDrain();
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite event suppressed as delayed self-write',
                    buildSqliteWatcherTraceExtra(paths),
                );
                return;
            }
        }

        if (sqliteDebounceTimer) {
            const timer = sqliteDebounceTimer;
            sqliteDebounceTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel SQLite debounce timer');
        }

        if (options.immediate) {
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite refresh requested immediately',
                buildSqliteWatcherTraceExtra(paths),
            );
            await runSqliteRefresh(generation);
            return;
        }

        const scheduledDuringRefresh = sqliteRefreshInFlight !== null;
        sqliteDebounceTimer = localDataWatcherDependencies.schedule(() => {
            if (!isCurrentWatcherGeneration(generation)) return;
            sqliteDebounceTimer = null;
            if (scheduledDuringRefresh && localDataWatcherDependencies.now() < sqliteIgnoreUntil) {
                hasPendingSqliteChangeDuringSelfWrite = true;
                pendingSqliteChangePaths = paths.slice(0, 8);
                scheduleSqliteIgnoreDrain();
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite scheduled refresh deferred after no-op window',
                    buildSqliteWatcherTraceExtra(paths, {
                        scheduledDuringRefresh: String(scheduledDuringRefresh),
                    }),
                );
                return;
            }
            void runSqliteRefresh(generation);
        }, DEBOUNCE_MS);
        localDataWatcherDependencies.logInfo(
            '[local-data-watcher] SQLite event scheduled refresh',
            buildSqliteWatcherTraceExtra(paths, {
                scheduledDuringRefresh: String(scheduledDuringRefresh),
            }),
        );
    }

    async function handleExternalChange(
        options: { immediate?: boolean; ignoreSelfWindow?: boolean } = {},
    ): Promise<void> {
        const generation = watcherGeneration;
        const now = localDataWatcherDependencies.now();
        pruneExpiredSelfWrites(now);

        if (!options.ignoreSelfWindow && now < ignoreUntil) {
            hasPendingChangeDuringIgnore = true;
            scheduleIgnoreDrain();
            return;
        }

        pendingExternalChange = true;

        if (debounceTimer) {
            const timer = debounceTimer;
            debounceTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel data debounce timer');
        }

        if (options.immediate) {
            await runPendingMerge(generation);
            return;
        }

        debounceTimer = localDataWatcherDependencies.schedule(() => {
            if (!isCurrentWatcherGeneration(generation)) return;
            debounceTimer = null;
            void runPendingMerge(generation);
        }, DEBOUNCE_MS);
    }

    // Cheap: rearmExhaustedWatchChannel below is a no-op unless a channel is
    // actually exhausted, so this is safe to call from a frequent trigger
    // (window focus) without the cost of a full disk refresh.
    function rearmExhaustedWatchers(): void {
        rearmExhaustedWatchChannel(dataWatchChannel);
        rearmExhaustedWatchChannel(sqliteWatchChannel);
    }

    async function refreshFromDiskNow(): Promise<void> {
        rearmExhaustedWatchers();
        await handleExternalChange({ immediate: true, ignoreSelfWindow: true });
    }

    function markLocalWrite(data?: AppData): void {
        const now = localDataWatcherDependencies.now();
        pruneExpiredSelfWrites(now);

        if (data) {
            try {
                const normalized = localDataWatcherDependencies.normalize(data);
                const payload = toStableJson(normalized);
                pendingSelfWrites = pendingSelfWrites.filter((entry) => entry.payload !== payload);
                pendingSelfWrites.push({
                    payload,
                    expiresAt: now + SELF_WRITE_RETENTION_MS,
                });
                if (pendingSelfWrites.length > MAX_PENDING_SELF_WRITES) {
                    pendingSelfWrites = pendingSelfWrites.slice(-MAX_PENDING_SELF_WRITES);
                }
            } catch {
                pendingSelfWrites = [];
            }
        } else {
            pendingSelfWrites = [];
        }
        ignoreUntil = now + IGNORE_WINDOW_MS;
        scheduleIgnoreDrain();
    }

    function markLocalSqliteWrite(): void {
        markSqliteSelfWriteWindow();
    }

    function runWatcherCleanupSafely(cleanup: (() => void) | null | undefined, label: string): void {
        if (!cleanup) return;
        try {
            cleanup();
        } catch (error) {
            try {
                localDataWatcherDependencies.logWarn(`[local-data-watcher] Failed to ${label}: ${String(error)}`);
            } catch {
                // Teardown must continue even if diagnostics are unavailable.
            }
        }
    }

    function cancelWatcherScheduleSafely(timer: ReturnType<typeof setTimeout>, label: string): void {
        runWatcherCleanupSafely(() => localDataWatcherDependencies.cancelSchedule(timer), label);
    }

    const clearWatchRegistrationRetry = (channel: WatchChannelState): void => {
        if (channel.retryTimer) {
            const timer = channel.retryTimer;
            channel.retryTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel file-watcher registration retry timer');
        }
    };

    const disposeWatchChannel = (channel: WatchChannelState): void => {
        clearWatchRegistrationRetry(channel);
        channel.retryCount = 0;
        channel.registration = null;
        channel.path = null;
        channel.callback = null;
        const unwatch = channel.unwatch;
        channel.unwatch = null;
        runWatcherCleanupSafely(unwatch, 'release file watcher');
    };

    const scheduleWatchRegistrationRetry = (channel: WatchChannelState): void => {
        if (!channel.path) return;
        if (channel.retryTimer || channel.retryCount >= MAX_WATCH_REGISTRATION_RETRIES) {
            if (channel.retryCount >= MAX_WATCH_REGISTRATION_RETRIES && !channel.retryTimer) {
                localDataWatcherDependencies.logWarn(
                    '[local-data-watcher] File watcher registration exhausted retries; channel blind until next re-arm',
                    { path: channel.path, maxRetries: String(MAX_WATCH_REGISTRATION_RETRIES) },
                );
            }
            return;
        }
        channel.retryCount += 1;
        const generation = watcherGeneration;
        const path = channel.path;
        const delayMs = WATCH_REGISTRATION_RETRY_COOLDOWN_MS * channel.retryCount;
        channel.retryTimer = localDataWatcherDependencies.schedule(() => {
            channel.retryTimer = null;
            if (generation !== watcherGeneration || channel.path !== path) return;
            void registerWatchChannel(channel);
        }, delayMs);
    };

    const registerWatchChannel = (channel: WatchChannelState): Promise<void> => {
        if (!channel.path || !channel.callback || channel.unwatch) return Promise.resolve();
        if (channel.registration) return channel.registration;

        const generation = watcherGeneration;
        const path = channel.path;
        const callback = channel.callback;
        const guardedCallback = (event: FsEvent) => {
            if (generation !== watcherGeneration || channel.path !== path) return;
            callback(event);
        };
        const registration = (async () => {
            try {
                const registered = await localDataWatcherDependencies.watchFile(path, guardedCallback);
                const unwatch = resolveUnwatch(registered);
                if (generation !== watcherGeneration || channel.path !== path) {
                    runWatcherCleanupSafely(unwatch, 'release stale file watcher');
                    return;
                }
                channel.unwatch = unwatch;
                channel.retryCount = 0;
                clearWatchRegistrationRetry(channel);
                localDataWatcherDependencies.logInfo(channel.startedMessage);
            } catch (error) {
                if (generation !== watcherGeneration || channel.path !== path) return;
                localDataWatcherDependencies.logWarn(channel.failedMessage + String(error));
                scheduleWatchRegistrationRetry(channel);
            }
        })();
        channel.registration = registration;
        return registration.finally(() => {
            if (channel.registration === registration) {
                channel.registration = null;
            }
        });
    };

    // A channel that exhausted its retry budget (scheduleWatchRegistrationRetry
    // above) stays blind until something re-arms it — no timer keeps trying on
    // its own. Coarse triggers (refreshFromDiskNow below) give it one fresh
    // shot per call by resetting the count; if that attempt also exhausts, the
    // per-burst cap applies again and it goes quiet until the next trigger, so
    // this can never spin unbounded on a permanently dead path.
    const rearmExhaustedWatchChannel = (channel: WatchChannelState): void => {
        if (!channel.path || channel.unwatch || channel.registration || channel.retryTimer) return;
        if (channel.retryCount < MAX_WATCH_REGISTRATION_RETRIES) return;
        channel.retryCount = 0;
        void registerWatchChannel(channel);
    };

    const startWatchChannel = (
        channel: WatchChannelState,
        path: string,
        callback: (event: FsEvent) => void,
        startedMessage: string,
        failedMessage: string,
    ): Promise<void> => {
        if (channel.path !== path) {
            disposeWatchChannel(channel);
            channel.path = path;
        }
        channel.callback = callback;
        channel.startedMessage = startedMessage;
        channel.failedMessage = failedMessage;
        return registerWatchChannel(channel);
    };

    async function start(dataPath: string, dbPath?: string): Promise<void> {
        if (!isTauriRuntime()) return;
        const registrations: Array<Promise<void>> = [
            startWatchChannel(
                dataWatchChannel,
                dataPath,
                (event) => {
                    const paths = normalizePathsFromEvent(event);
                    if (paths.length === 0) return;
                    // Skip iCloud placeholder events, lock files, and temp files to
                    // avoid spurious merges from iCloud Drive housekeeping operations.
                    if (!isRelevantSyncEvent(paths)) return;
                    void handleExternalChange();
                },
                '[local-data-watcher] Started watching ' + dataPath,
                '[local-data-watcher] Failed to start watcher: ',
            ),
        ];

        if (dbPath) {
            const dbWatchPath = getParentPath(dbPath) ?? dbPath;
            registrations.push(
                startWatchChannel(
                    sqliteWatchChannel,
                    dbWatchPath,
                    (event) => {
                        const paths = normalizePathsFromEvent(event);
                        if (paths.length === 0) return;
                        if (!isRelevantSqliteEvent(paths, dbPath)) return;
                        void handleSqliteChange({ paths });
                    },
                    '[local-data-watcher] Started watching SQLite directory ' + dbWatchPath,
                    '[local-data-watcher] Failed to start SQLite watcher: ',
                ),
            );
        } else {
            disposeWatchChannel(sqliteWatchChannel);
        }

        await Promise.all(registrations);

        // A write can land in the 750ms debounce right before a stop/start
        // (StrictMode/HMR/teardown) — stop() clears pendingExternalChange and
        // cancels that timer, so without this the change is only observed if
        // data.json changes again. Only run this when stop() actually dropped
        // one: an ordinary first start() at launch can beat fetchData, and
        // merging against the still-empty store here would persist a
        // full-document save with no CAS baseline and stomp the real load.
        if (droppedPendingChangeAtStop) {
            droppedPendingChangeAtStop = false;
            await handleExternalChange({ immediate: true, ignoreSelfWindow: true });
        }
    }

    function stop(): void {
        watcherGeneration += 1;
        // A real change is about to be dropped only if one was actually
        // pending (debounced or mid-debounce) — not on an ordinary stop with
        // nothing queued.
        if (pendingExternalChange || debounceTimer) {
            droppedPendingChangeAtStop = true;
        }
        const hadWatcherLifecycle = Boolean(
            dataWatchChannel.path ||
            sqliteWatchChannel.path ||
            dataWatchChannel.registration ||
            sqliteWatchChannel.registration ||
            dataWatchChannel.retryTimer ||
            sqliteWatchChannel.retryTimer,
        );
        disposeWatchChannel(dataWatchChannel);
        disposeWatchChannel(sqliteWatchChannel);
        if (debounceTimer) {
            const timer = debounceTimer;
            debounceTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel data debounce timer');
        }
        if (sqliteDebounceTimer) {
            const timer = sqliteDebounceTimer;
            sqliteDebounceTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel SQLite debounce timer');
        }
        if (ignoreDrainTimer) {
            const timer = ignoreDrainTimer;
            ignoreDrainTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel data ignore-drain timer');
        }
        if (sqliteIgnoreDrainTimer) {
            const timer = sqliteIgnoreDrainTimer;
            sqliteIgnoreDrainTimer = null;
            cancelWatcherScheduleSafely(timer, 'cancel SQLite ignore-drain timer');
        }
        clearMergedPersistRetry();
        clearSqliteRefreshRetry();
        if (sqliteEditUnlockUnsubscribe) {
            runWatcherCleanupSafely(sqliteEditUnlockUnsubscribe, 'release edit-unlock subscription');
            sqliteEditUnlockUnsubscribe = null;
        }
        hasPendingChangeDuringIgnore = false;
        hasPendingSqliteChangeDuringSelfWrite = false;
        pendingSqliteChangePaths = [];
        pendingExternalChange = false;
        pendingSelfWrites = [];
        // Aligned with resetForTests: a stale ignore window or hash from before
        // this stop() must not suppress or short-circuit the next start()'s
        // observations.
        ignoreUntil = 0;
        lastKnownHash = '';
        sqliteIgnoreUntil = 0;
        sqliteSelfWriteUntil = 0;
        lastSqliteSelfWriteAt = 0;
        sqliteSuppressedSelfWriteEvents = 0;

        if (hadWatcherLifecycle) {
            localDataWatcherDependencies.logInfo('[local-data-watcher] Stopped');
        }
    }

    const testUtils: LocalDataWatcherTestUtils = {
        setDependenciesForTests(overrides: Partial<LocalDataWatcherDependencies>) {
            localDataWatcherDependencies = {
                ...localDataWatcherDependencies,
                ...overrides,
            };
        },
        async triggerChangeForTests() {
            await handleExternalChange({ immediate: true });
        },
        async triggerSqliteChangeForTests() {
            await handleSqliteChange({ immediate: true });
        },
        async refreshFromDiskNowForTests() {
            await refreshFromDiskNow();
        },
        async waitForPendingMergeForTests() {
            while (mergeInFlight) {
                await mergeInFlight;
            }
        },
        async waitForPendingSqliteRefreshForTests() {
            while (sqliteRefreshInFlight) {
                await sqliteRefreshInFlight;
            }
        },
        resetForTests() {
            stop();
            resetDependencies();
            droppedPendingChangeAtStop = false;
            ignoreUntil = 0;
            sqliteIgnoreUntil = 0;
            sqliteSelfWriteUntil = 0;
            lastSqliteSelfWriteAt = 0;
            sqliteSuppressedSelfWriteEvents = 0;
            hasPendingSqliteChangeDuringSelfWrite = false;
            pendingSqliteChangePaths = [];
            lastKnownHash = '';
            pendingSelfWrites = [];
            mergeInFlight = null;
            mergeInFlightGeneration = null;
            sqliteRefreshInFlight = null;
            sqliteRefreshInFlightGeneration = null;
            delayedSqliteRefreshRetryCount = 0;
            dataWatchChannel = createWatchChannelState();
            sqliteWatchChannel = createWatchChannelState();
        },
        getPendingSelfWritePayloadLengthForTests() {
            return pendingSelfWrites.reduce((total, entry) => total + entry.payload.length, 0);
        },
    };

    return {
        refreshFromDiskNow,
        rearmExhaustedWatchers,
        markLocalWrite,
        markLocalSqliteWrite,
        start,
        stop,
        testUtils,
    };
};

const defaultLocalDataWatcherController = createLocalDataWatcherController();

export const refreshFromDiskNow = (): Promise<void> => defaultLocalDataWatcherController.refreshFromDiskNow();

export const rearmExhaustedWatchers = (): void => defaultLocalDataWatcherController.rearmExhaustedWatchers();

export const markLocalWrite = (data?: AppData): void => {
    defaultLocalDataWatcherController.markLocalWrite(data);
};

export const markLocalSqliteWrite = (): void => {
    defaultLocalDataWatcherController.markLocalSqliteWrite();
};

export const start = (dataPath: string, dbPath?: string): Promise<void> =>
    defaultLocalDataWatcherController.start(dataPath, dbPath);

export const stop = (): void => {
    defaultLocalDataWatcherController.stop();
};

export const __localDataWatcherTestUtils = defaultLocalDataWatcherController.testUtils;
