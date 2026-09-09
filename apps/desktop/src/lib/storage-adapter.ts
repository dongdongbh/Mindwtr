import {
    buildSaveSnapshot,
    computeStableValueFingerprint,
    type AppData,
    SQLITE_SCHEMA_VERSION,
    type StorageAdapter,
    type Task,
    type TaskQueryOptions,
    useTaskStore,
} from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';
import { logInfo, logWarn } from './app-log';
import { reportError } from './report-error';
import { markLocalSqliteWrite, markLocalWrite } from './local-data-watcher';
import {
    advanceSaveProvenance,
    buildChangedEntityBaseline,
    rebaseQueuedSettings,
} from './storage-save-baseline';

const STORAGE_SCHEMA_VERSION_KEY = 'mindwtr-storage-schema-version';
let storageInitLogged = false;
type SaveQueueOutcome = {
    canonical: AppData | null;
    confirmedBefore: AppData | null;
    provenance: AppData | null;
    failed: boolean;
    error?: unknown;
};
type SaveOperationResult = {
    canonical: AppData | null;
    attempted: AppData | null;
};
type NativeTaskSaveResult = {
    committed: true;
    canonical: AppData | null;
    canonicalReloadRequired: boolean;
};
let saveQueue: Promise<SaveQueueOutcome> = Promise.resolve({
    canonical: null,
    confirmedBefore: null,
    provenance: null,
    failed: false,
});
let pendingSaveCount = 0;
let lastSaveFailed = false;
let lastObservedData: AppData | null = null;
let lastPersistedData: AppData | null = null;
let saveVersion = 0;
let pendingCanonicalReconciliationCleanup: (() => void) | null = null;

/** Counts only this WebView's saves, not other processes or future work. */
export const getDesktopSaveStatus = () => ({
    pending: pendingSaveCount,
    generation: saveVersion,
    failed: lastSaveFailed,
    reconciliationPending: pendingCanonicalReconciliationCleanup !== null,
});

const beginSaveGeneration = (): number => {
    const cleanup = pendingCanonicalReconciliationCleanup;
    pendingCanonicalReconciliationCleanup = null;
    cleanup?.();
    saveVersion += 1;
    return saveVersion;
};

const scheduleCanonicalReconciliation = (
    attempted: AppData | null,
    canonical: AppData | null,
    attemptedSaveVersion: number,
): void => {
    if (!attempted) return;
    const attemptedFingerprint = computeStableValueFingerprint(attempted);
    if (canonical && attemptedFingerprint === computeStableValueFingerprint(canonical)) return;
    if (saveVersion !== attemptedSaveVersion) return;

    // Store actions finish applying their optimistic state after the adapter
    // promise resolves. Reconcile on the next task, and only if neither that
    // state nor the save generation has moved on in the meantime. An active
    // editor makes fetchData intentionally decline the update, so wait for its
    // lock to clear instead of dropping the authoritative canonical result.
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const cleanup = () => {
        if (initialTimer !== null) clearTimeout(initialTimer);
        initialTimer = null;
        unsubscribe?.();
        unsubscribe = null;
        if (pendingCanonicalReconciliationCleanup === cleanup) {
            pendingCanonicalReconciliationCleanup = null;
        }
    };
    pendingCanonicalReconciliationCleanup?.();
    pendingCanonicalReconciliationCleanup = cleanup;

    initialTimer = setTimeout(() => {
        initialTimer = null;
        const reconcileIfReady = (): 'finished' | 'waiting' => {
            if (saveVersion !== attemptedSaveVersion) return 'finished';
            const state = useTaskStore.getState();
            let currentFingerprint: string;
            try {
                currentFingerprint = computeStableValueFingerprint(buildSaveSnapshot(state));
            } catch {
                return 'finished';
            }
            if (currentFingerprint !== attemptedFingerprint) return 'finished';
            if (state.editLockCount > 0) return 'waiting';

            // Unsubscribe before fetchData mutates the store so its synchronous
            // state updates cannot re-enter this reconciliation callback.
            cleanup();
            const options = canonical
                ? { silent: true, preloadedData: canonical }
                : { silent: true };
            Promise.resolve(state.fetchData(options)).catch((error) => {
                reportError('canonical storage reconciliation failure', error, {
                    category: 'storage',
                    scope: 'storage',
                });
            });
            return 'finished';
        };

        if (reconcileIfReady() === 'finished') {
            cleanup();
            return;
        }
        unsubscribe = useTaskStore.subscribe(() => {
            if (reconcileIfReady() === 'finished') cleanup();
        });
        // Close the small gap between observing the lock and installing the
        // subscription. It remains one-shot: unlock reconciles, while a newer
        // snapshot/reset or save generation cancels it through the guards.
        if (reconcileIfReady() === 'finished') cleanup();
    }, 0);
};

// #913: save_data (and save_task, the same shape) can hang indefinitely
// without ever rejecting, so the normal catch block never fires and the UI
// looks fine while edits sit unsaved. This only observes and surfaces that
// through the store's error channel — it must never alter save/retry
// semantics (see the handoff's Do NOT list).
const SAVE_STUCK_WARNING_MS = 15_000;

const buildStuckSaveMessage = (label: string): string => (
    `${label} has not completed after ${SAVE_STUCK_WARNING_MS / 1000}s. `
    + 'Recent changes may not be saved yet.'
);

const setStorageWarning = (message: string | null) => {
    try {
        useTaskStore.getState().setError(message);
    } catch {
        // Store not initialized yet (e.g. very early startup); nothing to surface.
    }
};

// Shared by saveData and saveTask: runs `run`, surfacing a store warning if it
// hasn't settled after SAVE_STUCK_WARNING_MS, and clearing that warning (and
// only that warning) once it does. Observation only — never rejects, cancels,
// or retries `run` itself.
const withStuckSaveWarning = async <T>(command: string, label: string, run: () => Promise<T>): Promise<T> => {
    let stuckMessage: string | null = null;
    const stuckTimer = setTimeout(() => {
        stuckMessage = buildStuckSaveMessage(label);
        void logWarn(`${command} invoke has not completed`, {
            scope: 'storage',
            extra: { thresholdMs: SAVE_STUCK_WARNING_MS },
        });
        setStorageWarning(stuckMessage);
    }, SAVE_STUCK_WARNING_MS);
    try {
        return await run();
    } finally {
        clearTimeout(stuckTimer);
        // Only clear our own warning — never clobber an unrelated error that
        // may have been set (by the catch below, or elsewhere) in the meantime.
        if (stuckMessage) {
            try {
                if (useTaskStore.getState().error === stuckMessage) {
                    setStorageWarning(null);
                }
            } catch {
                // Store not initialized; nothing to clear.
            }
        }
    }
};

const enqueueSave = (
    operation: (
        predecessor: SaveQueueOutcome | null,
        recordPersisted: (result: SaveOperationResult) => void,
    ) => Promise<SaveOperationResult>,
): Promise<AppData | null> => {
    const predecessor: Promise<SaveQueueOutcome | null> = pendingSaveCount > 0
        ? saveQueue
        : Promise.resolve(null);
    const confirmedAtEnqueue = lastPersistedData;
    pendingSaveCount += 1;
    const outcome = predecessor.then(async (previous): Promise<SaveQueueOutcome> => {
        const confirmedBefore = previous ? previous.confirmedBefore : confirmedAtEnqueue;
        const provenanceBefore = previous ? previous.provenance : confirmedAtEnqueue;
        const progress: { persisted: SaveOperationResult | null } = { persisted: null };
        try {
            const result = await operation(previous, (persisted) => {
                progress.persisted = persisted;
            });
            return {
                canonical: result.canonical,
                confirmedBefore,
                provenance: provenanceBefore && result.attempted && result.canonical
                    ? advanceSaveProvenance(provenanceBefore, result.attempted, result.canonical)
                    : provenanceBefore,
                failed: false,
            };
        } catch (error) {
            const persistedResult = progress.persisted;
            return {
                canonical: null,
                confirmedBefore,
                provenance: provenanceBefore && persistedResult?.attempted && persistedResult.canonical
                    ? advanceSaveProvenance(
                        provenanceBefore,
                        persistedResult.attempted,
                        persistedResult.canonical,
                    )
                    : provenanceBefore,
                failed: true,
                error,
            };
        }
    });
    saveQueue = outcome;
    return outcome.then((result) => {
        pendingSaveCount -= 1;
        lastSaveFailed = result.failed;
        if (result.failed) throw result.error;
        return result.canonical;
    });
};

const invokeWithError = async <T>(
    action: string,
    command: string,
    args?: Record<string, unknown>
): Promise<T> => {
    try {
        return await invokeNative<T>(command, args);
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
            const data = await invokeNative<AppData>('get_data');
            lastObservedData = data;
            lastPersistedData = data;
            logStorageInitIfNeeded();
            return data;
        } catch (error) {
            try {
                const data = await invokeNative<AppData>('read_data_json');
                lastObservedData = data;
                lastPersistedData = data;
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
    saveData: async (data: AppData): Promise<AppData> => {
        // Associate the CAS baseline with this target before it enters the
        // queue. A getData() while another save is in flight must not widen
        // this save's observation set to newer rows it never saw.
        const observedBeforeSave = lastObservedData;
        const baselineEntities = observedBeforeSave
            ? buildChangedEntityBaseline(observedBeforeSave, data)
            : undefined;
        lastObservedData = data;
        const queuedSaveVersion = beginSaveGeneration();
        const canonical = await enqueueSave((predecessor, recordPersisted) => withStuckSaveWarning('save_data', 'Save', async () => {
            const provenance = predecessor?.provenance;
            const effectiveData = predecessor?.confirmedBefore && provenance
                ? {
                    ...data,
                    settings: rebaseQueuedSettings(
                        predecessor.confirmedBefore.settings,
                        data.settings,
                        provenance.settings,
                    ),
                }
                : data;
            markLocalWrite(effectiveData);
            markLocalSqliteWrite();
            try {
                // Provenance contains only rows actually observed at the queue
                // root or exactly confirmed from a predecessor's own target.
                const effectiveBaseline = provenance
                    ? buildChangedEntityBaseline(provenance, effectiveData)
                    : baselineEntities;
                const args = effectiveBaseline
                    ? { data: effectiveData, baselineEntities: effectiveBaseline }
                    : { data: effectiveData };
                let canonical = await invokeNative<AppData>('save_data', args);
                lastPersistedData = canonical;
                recordPersisted({ canonical, attempted: effectiveData });
                const settingsBaseline = provenance ?? observedBeforeSave;
                if (settingsBaseline) {
                    const replayedSettings = rebaseQueuedSettings(
                        settingsBaseline.settings,
                        effectiveData.settings,
                        canonical.settings,
                    );
                    if (
                        computeStableValueFingerprint(replayedSettings)
                        !== computeStableValueFingerprint(canonical.settings)
                    ) {
                        // The first whole-settings CAS missed, but some local
                        // fields remain non-conflicting. Retry once with only
                        // that delta replayed onto canonical data; a second
                        // race returns its canonical result without looping.
                        const retryData: AppData = { ...canonical, settings: replayedSettings };
                        const retryBaseline = buildChangedEntityBaseline(canonical, retryData);
                        markLocalWrite(retryData);
                        markLocalSqliteWrite();
                        canonical = await invokeNative<AppData>('save_data', {
                            data: retryData,
                            baselineEntities: retryBaseline,
                        } as any);
                        lastPersistedData = canonical;
                        recordPersisted({ canonical, attempted: effectiveData });
                    }
                }
                if (saveVersion === queuedSaveVersion) {
                    lastObservedData = canonical;
                }
                scheduleCanonicalReconciliation(data, canonical, queuedSaveVersion);
                markLocalSqliteWrite();
                logStorageInitIfNeeded();
                return { canonical, attempted: effectiveData };
            } catch (error) {
                if (saveVersion === queuedSaveVersion) {
                    lastObservedData = lastPersistedData;
                }
                reportError('saveData failure', error, { category: 'storage', scope: 'storage' });
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to save data: ${detail}`);
            }
        }));
        if (!canonical) throw new Error('save_data returned no canonical data');
        return canonical;
    },
    saveTask: async (task: Task): Promise<void> => {
        const baselineTask = lastObservedData && Array.isArray(lastObservedData.tasks)
            ? lastObservedData.tasks.find((item) => item.id === task.id)
            : undefined;
        let attemptedData = lastObservedData;
        if (attemptedData && Array.isArray(attemptedData.tasks)) {
            attemptedData = {
                ...attemptedData,
                tasks: baselineTask
                    ? attemptedData.tasks.map((item) => item.id === task.id ? task : item)
                    : [...attemptedData.tasks, task],
            };
            lastObservedData = attemptedData;
        }
        const queuedSaveVersion = beginSaveGeneration();
        await enqueueSave((predecessor, recordPersisted) => withStuckSaveWarning('save_task', 'Task save', async () => {
            markLocalSqliteWrite();
            try {
                const effectiveBaselineTask = predecessor?.provenance
                    ? predecessor.provenance.tasks.find((item) => item.id === task.id)
                    : baselineTask;
                const args = effectiveBaselineTask ? { task, baselineTask: effectiveBaselineTask } : { task };
                const nativeResult = await invokeNative<AppData | NativeTaskSaveResult>('save_task', args);
                if (
                    nativeResult
                    && typeof nativeResult === 'object'
                    && 'committed' in nativeResult
                    && nativeResult.committed === true
                    && 'canonicalReloadRequired' in nativeResult
                ) {
                    const canonical = nativeResult.canonical;
                    if (!canonical && nativeResult.canonicalReloadRequired) {
                        // SQLite already committed. Keep the optimistic store
                        // intact and reload canonical state after the store action
                        // finishes instead of falsely rejecting and retrying.
                        if (saveVersion === queuedSaveVersion) {
                            lastObservedData = attemptedData;
                        }
                        scheduleCanonicalReconciliation(attemptedData, null, queuedSaveVersion);
                        markLocalSqliteWrite();
                        logStorageInitIfNeeded();
                        return { canonical: null, attempted: attemptedData };
                    }
                    if (!canonical) {
                        throw new Error('save_task returned no canonical data');
                    }
                    lastPersistedData = canonical;
                    recordPersisted({ canonical, attempted: attemptedData });
                    if (saveVersion === queuedSaveVersion) {
                        lastObservedData = canonical;
                    }
                    scheduleCanonicalReconciliation(attemptedData, canonical, queuedSaveVersion);
                    markLocalSqliteWrite();
                    logStorageInitIfNeeded();
                    return { canonical, attempted: attemptedData };
                }
                const canonical = nativeResult as AppData;
                lastPersistedData = canonical;
                recordPersisted({ canonical, attempted: attemptedData });
                if (saveVersion === queuedSaveVersion) {
                    lastObservedData = canonical;
                }
                scheduleCanonicalReconciliation(attemptedData, canonical, queuedSaveVersion);
                markLocalSqliteWrite();
                logStorageInitIfNeeded();
                return { canonical, attempted: attemptedData };
            } catch (error) {
                if (saveVersion === queuedSaveVersion) {
                    lastObservedData = lastPersistedData;
                }
                reportError('saveTask failure', error, { category: 'storage', scope: 'storage' });
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to save task: ${detail}`);
            }
        }));
    },
    queryTasks: async (options: TaskQueryOptions) => {
        return invokeWithError('query tasks', 'query_tasks', { options });
    },
    searchAll: async (query: string) => {
        return invokeWithError('search', 'search_fts', { query });
    },
};
