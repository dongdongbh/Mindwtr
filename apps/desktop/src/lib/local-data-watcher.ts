import {
    type AppData,
    flushPendingSave,
    getInMemoryAppDataSnapshot,
    mergeAppData,
    normalizeAppData,
    useTaskStore,
} from '@mindwtr/core';
import { invoke } from '@tauri-apps/api/core';
import { getDesktopTimerHost, isTauriRuntime } from './runtime';
import { hashString, toStableJson } from './sync-service-utils';
import { logInfo, logWarn } from './app-log';

const IGNORE_WINDOW_MS = 2000;
const DEBOUNCE_MS = 750;
const IGNORE_DRAIN_PADDING_MS = 25;
const timerHost = getDesktopTimerHost();

type FsEvent = {
    path?: string;
    paths?: string[];
};

type LocalDataWatcherDependencies = {
    readDataJson: () => Promise<AppData>;
    watchFile: (path: string, callback: (event: FsEvent) => void) => Promise<unknown>;
    now: () => number;
    schedule: typeof setTimeout;
    cancelSchedule: typeof clearTimeout;
    hashPayload: (payload: string) => Promise<string>;
    normalize: (data: AppData) => AppData;
    merge: (local: AppData, incoming: AppData) => AppData;
    getSnapshot: () => AppData;
    persistMergedData: (merged: AppData) => Promise<void>;
    logInfo: (message: string) => void;
    logWarn: (message: string) => void;
};

const persistMergedDataThroughStore = async (merged: AppData): Promise<void> => {
    const allTasks = Array.isArray(merged.tasks) ? merged.tasks : [];
    const allProjects = Array.isArray(merged.projects) ? merged.projects : [];
    const allSections = Array.isArray(merged.sections) ? merged.sections : [];
    const allAreas = Array.isArray(merged.areas) ? merged.areas : [];

    useTaskStore.setState((state) => ({
        tasks: allTasks.filter((task) => !task.deletedAt && task.status !== 'archived'),
        projects: allProjects.filter((project) => !project.deletedAt),
        sections: allSections.filter((section) => !section.deletedAt),
        areas: allAreas.filter((area) => !area.deletedAt),
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        settings: merged.settings ?? state.settings,
        lastDataChangeAt: Date.now(),
    }));

    await useTaskStore.getState().persistSnapshot();
    await flushPendingSave();
};

const defaultDependencies: LocalDataWatcherDependencies = {
    readDataJson: () => invoke<AppData>('read_data_json' as any),
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
    persistMergedData: persistMergedDataThroughStore,
    logInfo: (message) => logInfo(message),
    logWarn: (message) => logWarn(message),
};

let localDataWatcherDependencies: LocalDataWatcherDependencies = { ...defaultDependencies };
let unwatchFn: (() => void) | null = null;
let ignoreUntil = 0;
let lastKnownHash = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let ignoreDrainTimer: ReturnType<typeof setTimeout> | null = null;
let hasPendingChangeDuringIgnore = false;
let pendingExternalData: AppData | null = null;
let mergeInFlight: Promise<void> | null = null;

const normalizePathsFromEvent = (event: FsEvent): string[] => {
    if (Array.isArray(event?.paths)) return event.paths;
    if (typeof event?.path === 'string' && event.path.length > 0) return [event.path];
    return [];
};

/** Filter out iCloud placeholder events (.icloud files, lock files). */
const isRelevantSyncEvent = (paths: string[]): boolean => {
    return paths.some((p) => {
        const name = p.split('/').pop() ?? '';
        // Ignore iCloud placeholder stubs (.filename.icloud)
        if (name.endsWith('.icloud')) return false;
        // Ignore our own advisory lock file
        if (name === '.mindwtr.lock') return false;
        // Ignore temp files from atomic writes
        if (name.endsWith('.tmp')) return false;
        return true;
    });
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

const scheduleIgnoreDrain = () => {
    if (!hasPendingChangeDuringIgnore) return;
    if (ignoreDrainTimer) {
        localDataWatcherDependencies.cancelSchedule(ignoreDrainTimer);
        ignoreDrainTimer = null;
    }
    const remainingMs = Math.max(0, ignoreUntil - localDataWatcherDependencies.now());
    ignoreDrainTimer = localDataWatcherDependencies.schedule(() => {
        ignoreDrainTimer = null;
        if (!hasPendingChangeDuringIgnore) return;
        hasPendingChangeDuringIgnore = false;
        void handleExternalChange();
    }, remainingMs + IGNORE_DRAIN_PADDING_MS);
};

const runPendingMerge = () => {
    if (mergeInFlight) return;

    mergeInFlight = (async () => {
        while (pendingExternalData) {
            const externalData = pendingExternalData;
            pendingExternalData = null;
            await mergeExternalData(externalData);
        }
    })().finally(() => {
        mergeInFlight = null;
        if (pendingExternalData) {
            runPendingMerge();
        }
    });
};

async function mergeExternalData(externalData: AppData): Promise<void> {
    try {
        await flushPendingSave();

        const localSnapshot = localDataWatcherDependencies.getSnapshot();
        const normalizedLocal = localDataWatcherDependencies.normalize(localSnapshot);
        const merged = localDataWatcherDependencies.merge(normalizedLocal, externalData);
        const normalizedMerged = localDataWatcherDependencies.normalize(merged);

        const localHash = await localDataWatcherDependencies.hashPayload(toStableJson(normalizedLocal));
        const mergedHash = await localDataWatcherDependencies.hashPayload(toStableJson(normalizedMerged));

        if (mergedHash === localHash) {
            lastKnownHash = mergedHash;
            return;
        }

        await localDataWatcherDependencies.persistMergedData(normalizedMerged);
        lastKnownHash = mergedHash;
        localDataWatcherDependencies.logInfo('[local-data-watcher] Merged external data.json changes');
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to merge external data: ' + String(error));
    }
}

async function handleExternalChange(): Promise<void> {
    if (localDataWatcherDependencies.now() < ignoreUntil) {
        hasPendingChangeDuringIgnore = true;
        scheduleIgnoreDrain();
        return;
    }

    try {
        const rawData = await localDataWatcherDependencies.readDataJson();
        const normalized = localDataWatcherDependencies.normalize(rawData);
        const hash = await localDataWatcherDependencies.hashPayload(toStableJson(normalized));

        if (hash === lastKnownHash) return;
        lastKnownHash = hash;

        if (debounceTimer) {
            localDataWatcherDependencies.cancelSchedule(debounceTimer);
            debounceTimer = null;
        }

        pendingExternalData = normalized;
        debounceTimer = localDataWatcherDependencies.schedule(() => {
            debounceTimer = null;
            runPendingMerge();
        }, DEBOUNCE_MS);
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to read external change: ' + String(error));
    }
}

export function markLocalWrite(): void {
    ignoreUntil = localDataWatcherDependencies.now() + IGNORE_WINDOW_MS;
    scheduleIgnoreDrain();
}

export async function start(dataPath: string): Promise<void> {
    if (!isTauriRuntime()) return;
    if (unwatchFn) return;

    try {
        const unwatch = await localDataWatcherDependencies.watchFile(dataPath, (event) => {
            const paths = normalizePathsFromEvent(event);
            if (paths.length === 0) return;
            // Skip iCloud placeholder events, lock files, and temp files to
            // avoid spurious merges from iCloud Drive housekeeping operations.
            if (!isRelevantSyncEvent(paths)) return;
            void handleExternalChange();
        });

        unwatchFn = resolveUnwatch(unwatch);
        localDataWatcherDependencies.logInfo('[local-data-watcher] Started watching ' + dataPath);
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to start watcher: ' + String(error));
    }
}

export function stop(): void {
    if (debounceTimer) {
        localDataWatcherDependencies.cancelSchedule(debounceTimer);
        debounceTimer = null;
    }
    if (ignoreDrainTimer) {
        localDataWatcherDependencies.cancelSchedule(ignoreDrainTimer);
        ignoreDrainTimer = null;
    }
    hasPendingChangeDuringIgnore = false;
    pendingExternalData = null;

    if (unwatchFn) {
        unwatchFn();
        unwatchFn = null;
        localDataWatcherDependencies.logInfo('[local-data-watcher] Stopped');
    }
}

export const __localDataWatcherTestUtils = {
    setDependenciesForTests(overrides: Partial<LocalDataWatcherDependencies>) {
        localDataWatcherDependencies = {
            ...localDataWatcherDependencies,
            ...overrides,
        };
    },
    async triggerChangeForTests() {
        await handleExternalChange();
    },
    resetForTests() {
        stop();
        localDataWatcherDependencies = { ...defaultDependencies };
        ignoreUntil = 0;
        lastKnownHash = '';
        mergeInFlight = null;
    },
};
