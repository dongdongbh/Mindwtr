import { createWithEqualityFn } from 'zustand/traditional';
import { useShallow } from 'zustand/react/shallow';
import { subscribeWithSelector } from 'zustand/middleware';
export { shallow } from 'zustand/shallow';

import type { AppData } from './types';
import type { StorageAdapter } from './storage';
import { noopStorage } from './storage';
import { logError, logWarn } from './logger';
import type { TaskStore } from './store-types';
import {
    buildEntityMap,
    sanitizeAppDataForStorage,
    selectVisibleAreas,
    selectVisibleProjects,
    selectVisibleSections,
    selectVisibleTasks,
    selectVisiblePeople,
} from './store-helpers';
import { markCoreStartupPhase } from './startup-profiler';
import { createProjectActions } from './store-projects';
import { createSettingsActions } from './store-settings';
import { createTaskActions } from './store-tasks';
import { sleep } from './async-utils';
import { instrumentStoreSubscribe } from './store-notify-profiler';
import { runAfterStoreWriteLock } from './data-transfer-transaction';

export { applyTaskUpdates } from './store-helpers';

let storage: StorageAdapter = noopStorage;

/**
 * Configure the storage adapter to use for persistence.
 * Must be called before using the store.
 */
export const setStorageAdapter = (adapter: StorageAdapter) => {
    storage = adapter;
};

export const getStorageAdapter = () => storage;

// Save queue helper - coalesces writes while ensuring the latest snapshot is persisted quickly.
type PendingSave = {
    version: number;
    data: AppData;
    onErrorCallbacks: Array<(msg: string) => void>;
    attempts: number;
};

let pendingSaves: PendingSave[] = [];
let pendingVersion = 0;
let savedVersion = 0;
let saveInFlight: Promise<void> | null = null;
const immediateSavesInFlight = new Set<Promise<void>>();
// Module-global: concurrent runWithImmediateSaveTracking scopes would cross-capture
// each other's saves. Callers must serialize (the MCP server does via its op queue).
const immediateSaveTrackers = new Set<Set<Promise<void>>>();
let scheduledSaveTimer: ReturnType<typeof setTimeout> | null = null;
let errorAutoClearTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceRetryInFlight: Promise<void> | null = null;
const MAX_PENDING_SAVES = 100;
const MAX_SAVE_RETRY_ATTEMPTS = 5;
const INITIAL_SAVE_RETRY_DELAY_MS = 250;
const MAX_SAVE_RETRY_DELAY_MS = 4000;
const SAVE_FLUSH_DELAY_MS = 120;
const ERROR_AUTO_CLEAR_MS = 10_000;
const SAVE_QUEUE_OVERFLOW_ERROR_PREFIX = 'Save queue overflow:';
const hasPendingSaveWork = (): boolean => pendingSaves.length > 0 || saveInFlight !== null || immediateSavesInFlight.size > 0;
/** Read-only diagnostics: does not flush, retry, or acknowledge persistence. */
export const getPersistenceStatus = () => ({
    queued: pendingSaves.length,
    inFlight: saveInFlight !== null,
    immediate: immediateSavesInFlight.size,
    retrying: persistenceRetryInFlight !== null,
    generation: pendingVersion,
    failed: useTaskStore.getState().persistenceFailure !== null,
});
const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);
const getSaveRetryDelayMs = (attempt: number): number => {
    const cappedAttempt = Math.max(0, attempt - 1);
    return Math.min(MAX_SAVE_RETRY_DELAY_MS, INITIAL_SAVE_RETRY_DELAY_MS * (2 ** cappedAttempt));
};
const isPersistentStoreError = (error: string | null | undefined): boolean => (
    typeof error === 'string' && error.startsWith(SAVE_QUEUE_OVERFLOW_ERROR_PREFIX)
);
const getSaveQueueOverflowMessage = ({
    droppedCount,
    droppedFromVersion,
    droppedToVersion,
    keptFromVersion,
    keptToVersion,
}: {
    droppedCount: number;
    droppedFromVersion: number;
    droppedToVersion: number;
    keptFromVersion: number;
    keptToVersion: number;
}): string => (
    `Save queue overflow: dropped ${droppedCount} queued save(s) `
    + `(versions ${droppedFromVersion}-${droppedToVersion}) while keeping versions ${keptFromVersion}-${keptToVersion}.`
);

const recordPersistenceFailure = (message: string) => {
    try {
        useTaskStore.setState({
            persistenceFailure: {
                message,
                failedAt: new Date().toISOString(),
                retrying: false,
            },
        });
    } catch {
        // Ignore if the store is not initialized yet.
    }
};

const clearPersistenceFailure = () => {
    try {
        if (useTaskStore.getState().persistenceFailure !== null) {
            useTaskStore.setState({ persistenceFailure: null });
        }
    } catch {
        // Ignore if the store is not initialized yet.
    }
};

const enforcePendingSaveCap = () => {
    if (pendingSaves.length <= MAX_PENDING_SAVES) return;
    const overflow = pendingSaves.length - MAX_PENDING_SAVES;
    const dropped = pendingSaves.splice(0, overflow);
    const firstDroppedVersion = dropped[0]?.version ?? 0;
    const lastDroppedVersion = dropped[dropped.length - 1]?.version ?? firstDroppedVersion;
    const keptFirstVersion = pendingSaves[0]?.version ?? lastDroppedVersion;
    const keptLastVersion = pendingSaves[pendingSaves.length - 1]?.version ?? keptFirstVersion;
    const message = getSaveQueueOverflowMessage({
        droppedCount: overflow,
        droppedFromVersion: firstDroppedVersion,
        droppedToVersion: lastDroppedVersion,
        keptFromVersion: keptFirstVersion,
        keptToVersion: keptLastVersion,
    });
    logWarn('Save queue overflow', {
        scope: 'store',
        category: 'storage',
        context: {
            droppedCount: overflow,
            droppedFromVersion: firstDroppedVersion,
            droppedToVersion: lastDroppedVersion,
            keptFromVersion: keptFirstVersion,
            keptToVersion: keptLastVersion,
        },
    });
    try {
        useTaskStore.getState().setError(message);
    } catch {
        // Ignore if the store is not initialized yet.
    }
    recordPersistenceFailure(message);
    const callbacks = dropped
        .flatMap((item) => item.onErrorCallbacks)
        .filter((callback): callback is (msg: string) => void => typeof callback === 'function');
    if (callbacks.length > 0) {
        for (const callback of callbacks) {
            try {
                callback(message);
            } catch {
                // Ignore callback failures so the queue can keep draining.
            }
        }
    }
    markCoreStartupPhase('core.debounced_save.capped', {
        dropped: overflow,
        queueLen: pendingSaves.length,
    });
};

const isStartupProfilingEnabled = (): boolean => {
    const g = globalThis as Record<string, unknown>;
    return g.__MINDWTR_STARTUP_PROFILING__ === true;
};

const getDebouncedSaveCaller = (): string | undefined => {
    if (!isStartupProfilingEnabled()) return undefined;
    try {
        const stack = new Error().stack;
        if (!stack) return undefined;
        const lines = stack.split('\n').map((line) => line.trim());
        // 0: Error, 1: getDebouncedSaveCaller, 2: debouncedSave, 3+: caller chain
        return lines[3] ?? lines[2];
    } catch {
        return undefined;
    }
};

const toSaveErrorMessage = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = detail.trim();
    if (!trimmed) return 'Failed to save data';
    return trimmed.toLowerCase().startsWith('failed to save data')
        ? trimmed
        : `Failed to save data: ${trimmed}`;
};

const scheduleErrorAutoClear = (error: string | null) => {
    if (errorAutoClearTimer) {
        clearTimeout(errorAutoClearTimer);
        errorAutoClearTimer = null;
    }
    if (!error || isPersistentStoreError(error)) return;
    errorAutoClearTimer = setTimeout(() => {
        errorAutoClearTimer = null;
        try {
            const state = useTaskStore.getState();
            if (state.error === error) {
                state.setError(null);
            }
        } catch {
            // Ignore if the store is not initialized yet.
        }
    }, ERROR_AUTO_CLEAR_MS);
};

const clearScheduledSaveTimer = () => {
    if (!scheduledSaveTimer) return;
    clearTimeout(scheduledSaveTimer);
    scheduledSaveTimer = null;
};

export const resetForTests = () => {
    clearScheduledSaveTimer();
    if (errorAutoClearTimer) {
        clearTimeout(errorAutoClearTimer);
        errorAutoClearTimer = null;
    }
    persistenceRetryInFlight = null;
};

type EntityCollectionConfig<T extends { id: string }> = {
    allKey: '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_allPeople';
    visibleKey: 'tasks' | 'projects' | 'sections' | 'areas' | 'people';
    mapKey: '_tasksById' | '_projectsById' | '_sectionsById' | '_areasById' | '_peopleById';
    selectVisible: (items: T[]) => T[];
};

const shouldEnforceStoreWriteContract = (): boolean => {
    if (typeof process === 'undefined') return true;
    return process.env?.NODE_ENV === 'development';
};

const normalizeEntityCollectionUpdate = <T extends { id: string }>(
    state: TaskStore,
    nextState: Partial<TaskStore>,
    config: EntityCollectionConfig<T>
) => {
    const { allKey, visibleKey, mapKey, selectVisible } = config;
    const touchesAll = hasOwnField(nextState, allKey);
    const touchesVisible = hasOwnField(nextState, visibleKey);
    const touchesMap = hasOwnField(nextState, mapKey);
    if (!touchesAll && !touchesVisible && !touchesMap) return;

    const record = nextState as Record<string, unknown>;
    const currentRecord = state as unknown as Record<string, unknown>;
    const enforceWriteContract = shouldEnforceStoreWriteContract();
    const visibleItems = record[visibleKey];
    const currentAll = currentRecord[allKey];
    const canUseVisibleCompatibilityUpdate =
        !enforceWriteContract &&
        touchesVisible &&
        Array.isArray(visibleItems) &&
        Array.isArray(currentAll) &&
        currentAll.length > 0 &&
        record[visibleKey] !== currentRecord[visibleKey] &&
        (!touchesAll || record[allKey] === currentRecord[allKey]);
    if (canUseVisibleCompatibilityUpdate) {
        const visibleArray = visibleItems as T[];
        const currentItems = currentAll as T[];
        const visibleIds = new Set(visibleArray.map((item) => item.id));
        const currentVisibleIds = new Set(selectVisible(currentItems).map((item) => item.id));
        const hiddenItems = currentItems.filter((item) => {
            if (visibleIds.has(item.id)) return false;
            return !currentVisibleIds.has(item.id);
        });
        const allItems = [...visibleArray, ...hiddenItems];
        record[allKey] = allItems;
        record[visibleKey] = selectVisible(allItems);
        record[mapKey] = buildEntityMap(allItems);
        return;
    }

    if (!touchesAll) {
        if (enforceWriteContract) {
            throw new Error(`TaskStore invariant violated: write ${allKey} instead of ${visibleKey}/${mapKey}`);
        }
        delete record[visibleKey];
        delete record[mapKey];
        return;
    }

    const nextAll = record[allKey];
    if (!Array.isArray(nextAll)) {
        throw new Error(`TaskStore invariant violated: ${allKey} must be an array`);
    }
    const allItems = nextAll as T[];
    record[visibleKey] = selectVisible(allItems);
    record[mapKey] = buildEntityMap(allItems);
};

const prepareStoreStateUpdate = (
    state: TaskStore,
    nextState: Partial<TaskStore> | TaskStore
): Partial<TaskStore> | TaskStore => {
    if (!nextState || nextState === state || typeof nextState !== 'object') {
        return nextState;
    }

    const prepared = { ...(nextState as Partial<TaskStore>) };
    normalizeEntityCollectionUpdate(state, prepared, {
        allKey: '_allTasks',
        visibleKey: 'tasks',
        mapKey: '_tasksById',
        selectVisible: selectVisibleTasks,
    });
    normalizeEntityCollectionUpdate(state, prepared, {
        allKey: '_allProjects',
        visibleKey: 'projects',
        mapKey: '_projectsById',
        selectVisible: selectVisibleProjects,
    });
    normalizeEntityCollectionUpdate(state, prepared, {
        allKey: '_allSections',
        visibleKey: 'sections',
        mapKey: '_sectionsById',
        selectVisible: selectVisibleSections,
    });
    normalizeEntityCollectionUpdate(state, prepared, {
        allKey: '_allAreas',
        visibleKey: 'areas',
        mapKey: '_areasById',
        selectVisible: selectVisibleAreas,
    });
    normalizeEntityCollectionUpdate(state, prepared, {
        allKey: '_allPeople',
        visibleKey: 'people',
        mapKey: '_peopleById',
        selectVisible: selectVisiblePeople,
    });

    if (hasOwnField(prepared, 'error')) {
        const currentError = state.error;
        const nextError = prepared.error ?? null;
        if (isPersistentStoreError(currentError) && nextError && !isPersistentStoreError(nextError)) {
            const { error: _ignored, ...rest } = prepared;
            return rest as Partial<TaskStore>;
        }
        scheduleErrorAutoClear(nextError);
    }

    return prepared;
};

const schedulePendingSaveFlush = () => {
    if (scheduledSaveTimer) return;
    scheduledSaveTimer = setTimeout(() => {
        scheduledSaveTimer = null;
        void flushPendingSave().catch((error) => {
            logError('Failed to flush pending save', { scope: 'store', category: 'storage', error });
            const message = toSaveErrorMessage(error);
            try {
                useTaskStore.getState().setError(message);
            } catch {
                // Ignore if store is not initialized yet
            }
        });
    }, SAVE_FLUSH_DELAY_MS);
};

const enqueuePendingSave = (
    data: AppData,
    onError?: (msg: string) => void,
    schedule = true,
    // Immediate-save retries pass their own dispatch-time ordinal (reserved
    // below) instead of drawing a fresh one — the version must reflect when
    // the snapshot's data was captured, not when its failed write settled.
    explicitVersion?: number,
) => {
    if (explicitVersion === undefined) pendingVersion += 1;
    const version = explicitVersion ?? pendingVersion;
    pendingSaves.push({
        version,
        data: sanitizeAppDataForStorage(data),
        onErrorCallbacks: onError ? [onError] : [],
        attempts: 0,
    });
    enforcePendingSaveCap();
    markCoreStartupPhase('core.debounced_save.enqueued', {
        version,
        queueLen: pendingSaves.length,
        caller: getDebouncedSaveCaller(),
    });
    if (schedule) schedulePendingSaveFlush();
};

const trackImmediateSave = (save: Promise<void>, retrySnapshot?: AppData): Promise<void> => {
    // Draw a real ordinal from the same counter debounced enqueues use, so
    // concurrent immediate dispatches (which never enqueue on their own) are
    // still ordered against each other and against debounced snapshots.
    pendingVersion += 1;
    const dispatchVersion = pendingVersion;
    let trackedSave: Promise<void>;
    trackedSave = save
        .catch((error) => {
            // Enqueue the retry snapshot unless a strictly newer snapshot is
            // already pending — cumulative store state means it already
            // contains this mutation. Check the queue itself, not the shared
            // counter: another concurrent immediate save may have reserved a
            // later ordinal without having enqueued (or failed) yet, and
            // skipping on that basis alone would drop this edit.
            if (retrySnapshot) {
                const hasNewerPending = pendingSaves.some((item) => item.version > dispatchVersion);
                if (!hasNewerPending) {
                    enqueuePendingSave(retrySnapshot, undefined, false, dispatchVersion);
                }
            }
            recordPersistenceFailure(toSaveErrorMessage(error));
            throw error;
        })
        .finally(() => {
            immediateSavesInFlight.delete(trackedSave);
        });
    immediateSaveTrackers.forEach((tracker) => tracker.add(trackedSave));
    immediateSavesInFlight.add(trackedSave);
    markCoreStartupPhase('core.immediate_save.enqueued', {
        inFlight: immediateSavesInFlight.size,
    });
    return trackedSave;
};

export const runWithImmediateSaveTracking = async <T>(operation: () => Promise<T>): Promise<{
    result: T;
    saveCount: number;
}> => {
    const saves = new Set<Promise<void>>();
    immediateSaveTrackers.add(saves);
    try {
        const result = await operation();
        await Promise.all(saves);
        return { result, saveCount: saves.size };
    } finally {
        immediateSaveTrackers.delete(saves);
    }
};

/**
 * Save data with write coalescing.
 * Captures a snapshot immediately and serializes writes to avoid lost updates.
 * @param data Snapshot of data to save (must include ALL items including tombstones)
 * @param onError Callback for save failures
 */
const debouncedSave = (data: AppData, onError?: (msg: string) => void) => {
    enqueuePendingSave(data, onError);
};

/**
 * Immediately save any pending debounced data.
 * Call this when the app goes to background or is about to be terminated.
 */
export const flushPendingSave = async (): Promise<void> => {
    clearScheduledSaveTimer();
    markCoreStartupPhase('core.flush_pending_save.enter', {
        queueLen: pendingSaves.length,
        inFlight: saveInFlight ? 1 : 0,
        immediateInFlight: immediateSavesInFlight.size,
    });
    while (true) {
        if (immediateSavesInFlight.size > 0) {
            const saves = Array.from(immediateSavesInFlight);
            markCoreStartupPhase('core.flush_pending_save.await_immediate', {
                inFlight: saves.length,
            });
            await Promise.all(saves);
            continue;
        }
        if (saveInFlight) {
            markCoreStartupPhase('core.flush_pending_save.await_in_flight');
            await saveInFlight;
            continue;
        }
        const currentQueue = Array.isArray(pendingSaves) ? pendingSaves : [];
        if (currentQueue.length === 0) {
            markCoreStartupPhase('core.flush_pending_save.exit_empty');
            return;
        }
        pendingSaves = [];
        const queuedSaves = currentQueue.filter((item): item is PendingSave =>
            !!item &&
            typeof item.version === 'number' &&
            !!item.data &&
            Array.isArray(item.onErrorCallbacks)
        );
        if (queuedSaves.length === 0) continue;
        const latestSave = queuedSaves[queuedSaves.length - 1];
        if (!latestSave || latestSave.version <= savedVersion) continue;
        markCoreStartupPhase('core.flush_pending_save.dequeue', {
            queued: queuedSaves.length,
            targetVersion: latestSave.version,
            savedVersion,
        });
        const targetVersion = latestSave.version;
        const dataToSave = latestSave.data;
        const onErrorCallbacks = queuedSaves
            .flatMap((item) => item.onErrorCallbacks)
            .filter((callback): callback is (msg: string) => void => typeof callback === 'function');
        const attempts = queuedSaves.reduce(
            (maxAttempts, item) => Math.max(maxAttempts, Number.isFinite(item.attempts) ? item.attempts : 0),
            0
        );
        let saveSucceeded = false;
        let saveError: unknown = null;
        saveInFlight = Promise.resolve()
            .then(() => {
                markCoreStartupPhase('core.flush_pending_save.storage_save:start', { targetVersion });
                return storage.saveData(dataToSave);
            })
            .then(() => {
                savedVersion = targetVersion;
                saveSucceeded = true;
                clearPersistenceFailure();
                markCoreStartupPhase('core.flush_pending_save.storage_save:end', { targetVersion });
            })
            .catch((e) => {
                saveError = e;
                markCoreStartupPhase('core.flush_pending_save.storage_save:error', { targetVersion });
                logError('Failed to flush pending save', { scope: 'store', category: 'storage', error: e });
                const message = toSaveErrorMessage(e);
                try {
                    useTaskStore.getState().setError(message);
                } catch {
                    // Ignore if store is not initialized yet
                }
            })
            .finally(() => {
                saveInFlight = null;
                if (!saveSucceeded) {
                    const hasNewerQueuedSave = pendingSaves.some((item) => item.version > targetVersion);
                    const nextAttempt = attempts + 1;
                    if (!hasNewerQueuedSave && nextAttempt < MAX_SAVE_RETRY_ATTEMPTS) {
                        pendingSaves.unshift({
                            version: targetVersion,
                            data: dataToSave,
                            onErrorCallbacks,
                            attempts: nextAttempt,
                        });
                        enforcePendingSaveCap();
                    }
                }
            });
        await saveInFlight;
        if (!saveSucceeded) {
            const hasQueuedSaves = pendingSaves.some((item) => item.version > targetVersion);
            if (hasQueuedSaves) continue;
            const hasRetriableSaveQueued = pendingSaves.some((item) => item.version === targetVersion);
            if (hasRetriableSaveQueued) {
                await sleep(getSaveRetryDelayMs(attempts + 1));
                continue;
            }
            const message = toSaveErrorMessage(saveError);
            recordPersistenceFailure(message);
            if (onErrorCallbacks.length > 0) {
                onErrorCallbacks.forEach((callback) => {
                    try {
                        callback(message);
                    } catch {
                        // Ignore callback failures so terminal save errors still surface.
                    }
                });
            }
            markCoreStartupPhase('core.flush_pending_save.exit_failed');
            throw saveError instanceof Error ? saveError : new Error(message);
        }
    }
};

const retryPendingPersistence = (): Promise<void> => {
    if (persistenceRetryInFlight) return persistenceRetryInFlight;

    const retry = Promise.resolve()
        .then(async () => {
            const currentFailure = useTaskStore.getState().persistenceFailure;
            if (currentFailure) {
                useTaskStore.setState({
                    persistenceFailure: { ...currentFailure, retrying: true },
                });
            }
            await useTaskStore.getState().persistSnapshot();
            await flushPendingSave();
        })
        .catch((error) => {
            recordPersistenceFailure(toSaveErrorMessage(error));
            throw error;
        })
        .finally(() => {
            persistenceRetryInFlight = null;
            const currentFailure = useTaskStore.getState().persistenceFailure;
            if (currentFailure?.retrying) {
                useTaskStore.setState({
                    persistenceFailure: { ...currentFailure, retrying: false },
                });
            }
        });
    persistenceRetryInFlight = retry;
    return retry;
};

const STORE_WRITE_ACTION_KEYS = [
    'seedGettingStarted',
    'addTask',
    'addTasks',
    'updateTask',
    'deleteTask',
    'restoreTask',
    'restoreTasks',
    'purgeTask',
    'purgeTasks',
    'purgeDeletedTasks',
    'duplicateTask',
    'promoteTaskToProject',
    'resetTaskChecklist',
    'moveTask',
    'batchUpdateTasks',
    'batchMoveTasks',
    'batchDeleteTasks',
    'reorderFocusedTasks',
    'addProject',
    'updateProject',
    'deleteProject',
    'restoreProject',
    'purgeProject',
    'purgeDeletedProjects',
    'duplicateProject',
    'toggleProjectFocus',
    'addSection',
    'updateSection',
    'deleteSection',
    'reorderSections',
    'addArea',
    'updateArea',
    'deleteArea',
    'restoreArea',
    'reorderAreas',
    'reorderProjects',
    'reorderProjectTasks',
    'reorderBoardTasks',
    'addPerson',
    'updatePerson',
    'renamePerson',
    'deletePerson',
    'restorePerson',
    'deleteTag',
    'renameTag',
    'deleteContext',
    'renameContext',
    'updateSettings',
    'persistSnapshot',
] as const satisfies readonly (keyof TaskStore)[];

const wrapStoreWriteActions = (actions: TaskStore): TaskStore => {
    const wrapped = { ...actions };
    for (const key of STORE_WRITE_ACTION_KEYS) {
        const action = actions[key] as (...args: unknown[]) => Promise<unknown>;
        (wrapped as unknown as Record<string, unknown>)[key] = (...args: unknown[]) =>
            runAfterStoreWriteLock(() => action(...args));
    }
    return wrapped;
};

export const useTaskStore = createWithEqualityFn<TaskStore>()(subscribeWithSelector((rawSet, get, api) => {
    instrumentStoreSubscribe(api);
    const set: typeof rawSet = (partial) => rawSet((state) => {
        const nextState = typeof partial === 'function' ? partial(state) : partial;
        return prepareStoreStateUpdate(state, nextState) as Partial<TaskStore> | TaskStore;
    });

    return wrapStoreWriteActions({
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
        isLoading: false,
        error: null,
        persistenceFailure: null,
        editLockCount: 0,
        lastDataChangeAt: 0,
        highlightTaskId: null,
        highlightTaskAt: null,
        // Internal: full data including tombstones
        _allTasks: [],
        _allProjects: [],
        _allSections: [],
        _allAreas: [],
        _allPeople: [],
        _tasksById: new Map(),
        _projectsById: new Map(),
        _sectionsById: new Map(),
        _areasById: new Map(),
        _peopleById: new Map(),
        setError: (error: string | null) => set({ error }),
        retryPersistence: retryPendingPersistence,
        lockEditing: () => set((state) => ({ editLockCount: state.editLockCount + 1 })),
        unlockEditing: () => set((state) => ({ editLockCount: Math.max(0, state.editLockCount - 1) })),
        ...createSettingsActions({
            set,
            get,
            debouncedSave,
            flushPendingSave,
            hasPendingSaveWork,
            getSaveGeneration: () => pendingVersion,
            getStorage: () => storage,
        }),
        ...createTaskActions({
            set,
            get,
            debouncedSave,
            flushPendingSave,
            trackImmediateSave,
            hasQueuedSnapshotSave: () => pendingSaves.length > 0,
            getStorage: () => storage,
        }),
        ...createProjectActions({
            set,
            get,
            debouncedSave,
            flushPendingSave,
        }),
    });
}));

const originalSetState = useTaskStore.setState;
// Zustand callers outside our action creators can still use setState directly.
// Keep all external writes flowing through prepareStoreStateUpdate so derived maps,
// tombstone-aware collections, and visible lists stay aligned.
useTaskStore.setState = ((partial, replace) => {
    if (typeof partial === 'function') {
        originalSetState((state) => prepareStoreStateUpdate(state, partial(state as TaskStore) as Partial<TaskStore> | TaskStore), replace);
        return;
    }
    originalSetState(prepareStoreStateUpdate(useTaskStore.getState(), partial as Partial<TaskStore> | TaskStore), replace);
}) as typeof useTaskStore.setState;

export const useTaskById = (id: string) =>
    useTaskStore((state) => state._tasksById.get(id));

export const useProjectById = (id?: string | null) =>
    useTaskStore((state) => (id ? state._projectsById.get(id) : undefined));

export const useVisibleTaskIds = () =>
    useTaskStore(useShallow((state) => state.tasks.map((task) => task.id)));
