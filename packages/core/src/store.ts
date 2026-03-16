import { createWithEqualityFn } from 'zustand/traditional';
export { shallow } from 'zustand/shallow';

import type { AppData } from './types';
import type { StorageAdapter } from './storage';
import { noopStorage } from './storage';
import { logError } from './logger';
import type { TaskStore } from './store-types';
import { sanitizeAppDataForStorage } from './store-helpers';
import { markCoreStartupPhase } from './startup-profiler';
import { createProjectActions } from './store-projects';
import { createSettingsActions } from './store-settings';
import { createTaskActions } from './store-tasks';

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
const MAX_PENDING_SAVES = 100;
const MAX_SAVE_RETRY_ATTEMPTS = 5;
const INITIAL_SAVE_RETRY_DELAY_MS = 250;
const MAX_SAVE_RETRY_DELAY_MS = 4000;
const hasPendingSaveWork = (): boolean => pendingSaves.length > 0 || saveInFlight !== null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const getSaveRetryDelayMs = (attempt: number): number => {
    const cappedAttempt = Math.max(0, attempt - 1);
    return Math.min(MAX_SAVE_RETRY_DELAY_MS, INITIAL_SAVE_RETRY_DELAY_MS * (2 ** cappedAttempt));
};
const getSaveQueueOverflowMessage = (droppedCount: number): string =>
    `Save queue overflow: dropped ${droppedCount} stale snapshot(s) while keeping the newest state.`;

const enforcePendingSaveCap = () => {
    if (pendingSaves.length <= MAX_PENDING_SAVES) return;
    const overflow = pendingSaves.length - MAX_PENDING_SAVES;
    // Keep only the newest saves — oldest are stale and safe to drop.
    const dropped = pendingSaves.splice(0, overflow);
    const callbacks = dropped
        .flatMap((item) => item.onErrorCallbacks)
        .filter((callback): callback is (msg: string) => void => typeof callback === 'function');
    if (callbacks.length > 0) {
        const message = getSaveQueueOverflowMessage(overflow);
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

/**
 * Save data with write coalescing.
 * Captures a snapshot immediately and serializes writes to avoid lost updates.
 * @param data Snapshot of data to save (must include ALL items including tombstones)
 * @param onError Callback for save failures
 */
const debouncedSave = (data: AppData, onError?: (msg: string) => void) => {
    pendingVersion += 1;
    pendingSaves.push({
        version: pendingVersion,
        data: sanitizeAppDataForStorage(data),
        onErrorCallbacks: onError ? [onError] : [],
        attempts: 0,
    });
    enforcePendingSaveCap();
    markCoreStartupPhase('core.debounced_save.enqueued', {
        version: pendingVersion,
        queueLen: pendingSaves.length,
        caller: getDebouncedSaveCaller(),
    });
    void flushPendingSave().catch((error) => {
        logError('Failed to flush pending save', { scope: 'store', category: 'storage', error });
        const message = toSaveErrorMessage(error);
        try {
            useTaskStore.getState().setError(message);
        } catch {
            // Ignore if store is not initialized yet
        }
    });
};

/**
 * Immediately save any pending debounced data.
 * Call this when the app goes to background or is about to be terminated.
 */
export const flushPendingSave = async (): Promise<void> => {
    markCoreStartupPhase('core.flush_pending_save.enter', {
        queueLen: pendingSaves.length,
        inFlight: saveInFlight ? 1 : 0,
    });
    while (true) {
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

export const useTaskStore = createWithEqualityFn<TaskStore>()((set, get) => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
    isLoading: false,
    error: null,
    editLockCount: 0,
    lastDataChangeAt: 0,
    highlightTaskId: null,
    highlightTaskAt: null,
    // Internal: full data including tombstones
    _allTasks: [],
    _allProjects: [],
    _allSections: [],
    _allAreas: [],
    setError: (error: string | null) => set({ error }),
    lockEditing: () => set((state) => ({ editLockCount: state.editLockCount + 1 })),
    unlockEditing: () => set((state) => ({ editLockCount: Math.max(0, state.editLockCount - 1) })),
    ...createSettingsActions({
        set,
        get,
        debouncedSave,
        flushPendingSave,
        hasPendingSaveWork,
        getStorage: () => storage,
    }),
    ...createTaskActions({
        set,
        get,
        debouncedSave,
        getStorage: () => storage,
    }),
    ...createProjectActions({
        set,
        get,
        debouncedSave,
    }),
}));
