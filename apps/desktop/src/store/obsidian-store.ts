import { normalizeObsidianRelativePath, type ObsidianTask } from '@mindwtr/core';
import { createWithEqualityFn } from 'zustand/traditional';
import {
    ObsidianService,
    type ObsidianConfig,
    type ObsidianFilesChangedPayload,
} from '../lib/obsidian-service';
import {
    isObsidianFileInScanFolders,
    normalizeObsidianConfig,
    type ObsidianImportMode,
    sortObsidianTasks,
} from '../lib/obsidian-scanner';
import { useUiStore } from './ui-store';

type ObsidianWatchUpdateResult = {
    changedCount: number;
    deletedCount: number;
    warnings: string[];
    skippedBeforeInitialScan: boolean;
};

type ObsidianStoreState = {
    config: ObsidianConfig;
    tasks: ObsidianTask[];
    scannedFileCount: number;
    scannedRelativePaths: string[];
    taskNotesDetectedPaths: string[];
    warnings: string[];
    importMode: ObsidianImportMode;
    hasScannedThisSession: boolean;
    hasVaultMarker: boolean | null;
    isLoadingConfig: boolean;
    isScanning: boolean;
    isWatching: boolean;
    isInitialized: boolean;
    error: string | null;
    watcherError: string | null;
    refreshConfig: () => Promise<void>;
    loadConfig: () => Promise<void>;
    saveConfig: (nextConfig: Partial<ObsidianConfig>) => Promise<ObsidianConfig>;
    updateConfig: (nextConfig: Partial<ObsidianConfig>) => Promise<ObsidianConfig>;
    setVaultPath: (vaultPath: string | null, options?: { enabled?: boolean }) => Promise<ObsidianConfig>;
    removeConfig: () => Promise<void>;
    disconnect: () => Promise<void>;
    refreshVaultMarker: () => Promise<void>;
    scan: () => Promise<void>;
    rescan: () => Promise<void>;
    startWatcher: () => Promise<void>;
    stopWatcher: () => Promise<void>;
    handleFilesChanged: (payload: ObsidianFilesChangedPayload) => Promise<ObsidianWatchUpdateResult | null>;
    clearError: () => void;
};

const defaultConfig = normalizeObsidianConfig({});
let watchUpdateQueue: Promise<ObsidianWatchUpdateResult | null> = Promise.resolve(null);

const toErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const text = String(error || '').trim();
    return text || fallback;
};

const enqueueWatchUpdate = (
    work: () => Promise<ObsidianWatchUpdateResult | null>
): Promise<ObsidianWatchUpdateResult | null> => {
    const next = watchUpdateQueue.catch(() => null).then(work);
    watchUpdateQueue = next.catch(() => null);
    return next;
};

const normalizeEventPaths = (paths: string[], config: ObsidianConfig): string[] => {
    const normalized = new Set<string>();
    for (const rawPath of paths) {
        try {
            const relativePath = normalizeObsidianRelativePath(rawPath);
            if (!relativePath) continue;
            if (!isObsidianFileInScanFolders(relativePath, config.scanFolders)) continue;
            normalized.add(relativePath);
        } catch {
            continue;
        }
    }
    return [...normalized].sort((left, right) => left.localeCompare(right));
};

const scanConfigChanged = (left: ObsidianConfig, right: ObsidianConfig): boolean => {
    return left.vaultPath !== right.vaultPath
        || left.scanFolders.join('\n') !== right.scanFolders.join('\n')
        || left.taskNotesIncludeArchived !== right.taskNotesIncludeArchived;
};

export const useObsidianStore = createWithEqualityFn<ObsidianStoreState>()((set, get) => ({
    config: defaultConfig,
    tasks: [],
    scannedFileCount: 0,
    scannedRelativePaths: [],
    taskNotesDetectedPaths: [],
    warnings: [],
    importMode: 'inline',
    hasScannedThisSession: false,
    hasVaultMarker: null,
    isLoadingConfig: false,
    isScanning: false,
    isWatching: false,
    isInitialized: false,
    error: null,
    watcherError: null,
    refreshConfig: async () => {
        await get().loadConfig();
    },
    loadConfig: async () => {
        if (get().isLoadingConfig) return;
        set({ isLoadingConfig: true, error: null });
        try {
            const config = normalizeObsidianConfig(await ObsidianService.getConfig());
            const hasVaultMarker = config.vaultPath ? await ObsidianService.hasVaultMarker(config.vaultPath) : null;
            set({
                config,
                hasVaultMarker,
                warnings: [],
                ...(config.enabled && config.vaultPath
                    ? {}
                    : {
                        tasks: [],
                        scannedFileCount: 0,
                        scannedRelativePaths: [],
                        taskNotesDetectedPaths: [],
                        importMode: 'inline',
                        hasScannedThisSession: false,
                    }),
                isInitialized: true,
                isLoadingConfig: false,
            });
        } catch (error) {
            set({
                isLoadingConfig: false,
                isInitialized: true,
                error: toErrorMessage(error, 'Failed to load Obsidian config.'),
            });
        }
    },
    saveConfig: async (nextConfig) => {
        return get().updateConfig(nextConfig);
    },
    updateConfig: async (nextConfig) => {
        const merged = normalizeObsidianConfig({ ...get().config, ...nextConfig });
        const saved = normalizeObsidianConfig(await ObsidianService.setConfig(merged));
        const hasVaultMarker = saved.vaultPath ? await ObsidianService.hasVaultMarker(saved.vaultPath) : null;
        const previousConfig = get().config;
        const shouldResetScanState = scanConfigChanged(previousConfig, saved);
        set({
            config: saved,
            hasVaultMarker,
            warnings: [],
            error: null,
            watcherError: null,
            hasScannedThisSession: false,
            ...(shouldResetScanState
                ? {
                    tasks: [],
                    scannedFileCount: 0,
                    scannedRelativePaths: [],
                    taskNotesDetectedPaths: [],
                    importMode: 'inline',
                }
                : {}),
        });
        if (!saved.enabled || !saved.vaultPath) {
            set({
                tasks: [],
                scannedFileCount: 0,
                scannedRelativePaths: [],
                taskNotesDetectedPaths: [],
                warnings: [],
                importMode: 'inline',
                hasScannedThisSession: false,
                isWatching: false,
                watcherError: null,
            });
        }
        return saved;
    },
    setVaultPath: async (vaultPath, options) => {
        const trimmed = String(vaultPath || '').trim() || null;
        const current = get().config;
        const next = await get().updateConfig({
            ...current,
            vaultPath: trimmed,
            enabled: trimmed ? options?.enabled ?? true : false,
            lastScannedAt: trimmed ? current.lastScannedAt : null,
        });
        return next;
    },
    removeConfig: async () => {
        await get().disconnect();
    },
    disconnect: async () => {
        await get().updateConfig({
            vaultPath: null,
            enabled: false,
            lastScannedAt: null,
            scanFolders: ['/'],
        });
        set({
            tasks: [],
            scannedFileCount: 0,
            scannedRelativePaths: [],
            taskNotesDetectedPaths: [],
            warnings: [],
            importMode: 'inline',
            hasScannedThisSession: false,
            hasVaultMarker: null,
            isWatching: false,
            watcherError: null,
        });
    },
    refreshVaultMarker: async () => {
        const vaultPath = get().config.vaultPath;
        const hasVaultMarker = vaultPath ? await ObsidianService.hasVaultMarker(vaultPath) : null;
        set({ hasVaultMarker });
    },
    scan: async () => {
        await get().rescan();
    },
    rescan: async () => {
        if (get().isScanning) return;
        const config = get().config;
        if (!config.enabled || !config.vaultPath) {
            set({
                tasks: [],
                scannedFileCount: 0,
                scannedRelativePaths: [],
                taskNotesDetectedPaths: [],
                warnings: [],
                importMode: 'inline',
                hasScannedThisSession: false,
            });
            return;
        }

        const startedAt = new Date().toISOString();
        set({ isScanning: true, error: null });
        try {
            const result = await ObsidianService.scanVault(config);
            const savedConfig = await ObsidianService.setConfig({
                ...config,
                lastScannedAt: startedAt,
            });
            set({
                config: savedConfig,
                tasks: result.tasks,
                scannedFileCount: result.scannedFileCount,
                scannedRelativePaths: result.scannedRelativePaths,
                taskNotesDetectedPaths: result.taskNotesDetectedPaths,
                warnings: result.warnings,
                importMode: result.importMode,
                hasScannedThisSession: true,
                isScanning: false,
                error: null,
            });
        } catch (error) {
            set({
                warnings: [],
                importMode: 'inline',
                hasScannedThisSession: true,
                isScanning: false,
                error: toErrorMessage(error, 'Failed to scan Obsidian vault.'),
            });
        }
    },
    startWatcher: async () => {
        const config = get().config;
        if (!config.enabled || !config.vaultPath) {
            await get().stopWatcher();
            return;
        }

        try {
            await ObsidianService.startWatcher(config, {
                onFilesChanged: async (payload) => {
                    const result = await get().handleFilesChanged(payload);
                    if (!result || result.skippedBeforeInitialScan) return;
                    const totalFiles = result.changedCount + result.deletedCount;
                    if (totalFiles > 0) {
                        useUiStore.getState().showToast(
                            totalFiles === 1 ? 'Updated 1 Obsidian file.' : `Updated ${totalFiles} Obsidian files.`,
                            'info',
                            2500,
                        );
                        return;
                    }
                    if (result.warnings.length > 0) {
                        useUiStore.getState().showToast(result.warnings[0], 'info', 6000);
                    }
                },
                onError: (message) => {
                    set({
                        isWatching: false,
                        watcherError: message,
                    });
                    void ObsidianService.stopWatcher();
                },
            });
            set({
                isWatching: true,
                watcherError: null,
            });
        } catch (error) {
            set({
                isWatching: false,
                watcherError: toErrorMessage(error, 'Failed to start live Obsidian updates.'),
            });
        }
    },
    stopWatcher: async () => {
        await ObsidianService.stopWatcher();
        set({
            isWatching: false,
            watcherError: null,
        });
    },
    handleFilesChanged: async (payload) => enqueueWatchUpdate(async () => {
        const config = get().config;
        if (!config.enabled || !config.vaultPath) return null;

        const changed = normalizeEventPaths(payload.changed, config);
        const deleted = normalizeEventPaths(payload.deleted, config)
            .filter((path) => !changed.includes(path));

        if (changed.length === 0 && deleted.length === 0) {
            return null;
        }

        if (!get().hasScannedThisSession) {
            return {
                changedCount: changed.length,
                deletedCount: deleted.length,
                warnings: [],
                skippedBeforeInitialScan: true,
            };
        }

        const deletedSet = new Set(deleted);
        let nextTasks = get().tasks.filter((task) => !deletedSet.has(task.source.relativeFilePath));
        const nextRelativePaths = new Set(get().scannedRelativePaths);
        const currentTaskNotesDetectedPaths = new Set(get().taskNotesDetectedPaths);
        const nextTaskNotesDetectedPaths = new Set(currentTaskNotesDetectedPaths);
        const warnings: string[] = [];
        const currentImportMode = get().importMode;
        let touchedExistingTaskNotesFile = false;
        let shouldRescan = false;

        for (const deletedPath of deleted) {
            nextRelativePaths.delete(deletedPath);
            nextTaskNotesDetectedPaths.delete(deletedPath);
            if (currentTaskNotesDetectedPaths.has(deletedPath)) {
                touchedExistingTaskNotesFile = true;
            }
        }

        let changedCount = 0;
        for (const changedPath of changed) {
            try {
                const fileResult = await ObsidianService.scanFile(config, changedPath);
                if (fileResult.warning) warnings.push(fileResult.warning);

                nextTasks = nextTasks.filter((task) => task.source.relativeFilePath !== changedPath);
                nextRelativePaths.delete(changedPath);
                nextTaskNotesDetectedPaths.delete(changedPath);

                if (currentImportMode === 'inline' && fileResult.detectedTaskNotes) {
                    shouldRescan = true;
                    changedCount += 1;
                    break;
                }

                if (currentImportMode === 'tasknotes' && currentTaskNotesDetectedPaths.has(changedPath) && !fileResult.detectedTaskNotes) {
                    touchedExistingTaskNotesFile = true;
                }

                if (fileResult.detectedTaskNotes) {
                    nextTaskNotesDetectedPaths.add(fileResult.relativeFilePath);
                }

                if (fileResult.isTracked) {
                    if (currentImportMode === 'tasknotes') {
                        if (fileResult.detectedTaskNotes) {
                            nextTasks.push(...fileResult.tasks);
                        }
                    } else {
                        nextTasks.push(...fileResult.tasks);
                    }
                    nextRelativePaths.add(fileResult.relativeFilePath);
                }
                changedCount += 1;
            } catch (error) {
                warnings.push(toErrorMessage(error, `Failed to refresh ${changedPath}.`));
            }
        }

        if (!shouldRescan && currentImportMode === 'tasknotes' && touchedExistingTaskNotesFile) {
            if (nextTaskNotesDetectedPaths.size === 0) {
                shouldRescan = true;
            }
        }

        if (!shouldRescan && currentImportMode === 'tasknotes' && get().tasks.length === 0) {
            shouldRescan = true;
        }

        if (shouldRescan) {
            await get().rescan();
            const nextState = get();
            return {
                changedCount: changed.length,
                deletedCount: deleted.length,
                warnings: nextState.error ? [nextState.error] : nextState.warnings,
                skippedBeforeInitialScan: false,
            };
        }

        set({
            tasks: sortObsidianTasks(nextTasks),
            scannedFileCount: nextRelativePaths.size,
            scannedRelativePaths: [...nextRelativePaths].sort((left, right) => left.localeCompare(right)),
            taskNotesDetectedPaths: [...nextTaskNotesDetectedPaths].sort((left, right) => left.localeCompare(right)),
            warnings,
            error: null,
        });

        return {
            changedCount,
            deletedCount: deleted.length,
            warnings,
            skippedBeforeInitialScan: false,
        };
    }),
    clearError: () => set({ error: null }),
}));
