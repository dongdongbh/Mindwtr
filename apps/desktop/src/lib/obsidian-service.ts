import type { ObsidianSourceRef } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { reportError } from './report-error';
import { logWarn } from './app-log';
import {
    deriveVaultName,
    normalizeObsidianConfig,
    scanObsidianFile,
    sanitizeScanFolders,
    scanObsidianVault,
    type ObsidianConfig,
    type ObsidianFileScanResult,
    type ObsidianScanResult,
} from './obsidian-scanner';

const OBSIDIAN_CONFIG_KEY = 'mindwtr-obsidian-config';

export type ObsidianFilesChangedPayload = {
    changed: string[];
    deleted: string[];
};

type ObsidianWatcherErrorPayload = {
    message?: string;
};

type ObsidianWatcherHandlers = {
    onFilesChanged: (payload: ObsidianFilesChangedPayload) => void | Promise<void>;
    onError: (message: string) => void | Promise<void>;
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as never, args as never);
}

const safeJsonParse = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
};

const readStoredConfig = (): ObsidianConfig => {
    const parsed = safeJsonParse<Partial<ObsidianConfig>>(localStorage.getItem(OBSIDIAN_CONFIG_KEY), {});
    return normalizeObsidianConfig(parsed);
};

const writeStoredConfig = (config: ObsidianConfig): void => {
    localStorage.setItem(OBSIDIAN_CONFIG_KEY, JSON.stringify(config));
};

export const parseScanFoldersInput = (input: string): string[] => {
    const parts = input
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
    return sanitizeScanFolders(parts);
};

export const formatScanFoldersInput = (scanFolders: string[]): string => sanitizeScanFolders(scanFolders).join(', ');
export const normalizeObsidianScanFolders = sanitizeScanFolders;
export const buildObsidianUri = (source: ObsidianSourceRef): string => {
    const vault = encodeURIComponent(source.vaultName || deriveVaultName(source.vaultPath));
    const file = encodeURIComponent(source.relativeFilePath.replace(/\.md$/i, ''));
    return `obsidian://open?vault=${vault}&file=${file}`;
};

export class ObsidianService {
    private static watcherStop: (() => void) | null = null;

    private static watcherVaultPath: string | null = null;

    static async getConfig(): Promise<ObsidianConfig> {
        if (!isTauriRuntime()) {
            return readStoredConfig();
        }

        try {
            return normalizeObsidianConfig(await tauriInvoke<Partial<ObsidianConfig>>('get_obsidian_config'));
        } catch (error) {
            reportError('Failed to read Obsidian config', error);
            return readStoredConfig();
        }
    }

    static async setConfig(config: Partial<ObsidianConfig>): Promise<ObsidianConfig> {
        const normalized = normalizeObsidianConfig(config);
        if (!isTauriRuntime()) {
            writeStoredConfig(normalized);
            return normalized;
        }

        try {
            const saved = await tauriInvoke<Partial<ObsidianConfig>>('set_obsidian_config', { config: normalized });
            return normalizeObsidianConfig(saved);
        } catch (error) {
            reportError('Failed to save Obsidian config', error);
            writeStoredConfig(normalized);
            return normalized;
        }
    }

    static async selectVaultFolder(title: string): Promise<string | null> {
        if (!isTauriRuntime()) return null;
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            directory: true,
            multiple: false,
            title,
        });
        return typeof selected === 'string' && selected.trim() ? selected : null;
    }

    static async hasVaultMarker(vaultPath: string | null): Promise<boolean | null> {
        const trimmed = String(vaultPath || '').trim();
        if (!trimmed) return null;
        if (!isTauriRuntime()) return null;
        try {
            return await tauriInvoke<boolean>('check_obsidian_vault_marker', { vaultPath: trimmed });
        } catch (error) {
            void logWarn('Failed to check Obsidian vault marker', {
                scope: 'obsidian',
                extra: {
                    vaultPath: trimmed,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            return null;
        }
    }

    static async inspectVault(vaultPath: string | null): Promise<{ hasObsidianDir: boolean | null }> {
        return {
            hasObsidianDir: await ObsidianService.hasVaultMarker(vaultPath),
        };
    }

    static async scanVault(config: ObsidianConfig): Promise<ObsidianScanResult> {
        if (!isTauriRuntime()) {
            return {
                tasks: [],
                scannedFileCount: 0,
                scannedRelativePaths: [],
                taskNotesDetectedPaths: [],
                warnings: [],
                importMode: 'inline',
            };
        }

        const { exists, readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
        return scanObsidianVault(config, {
            exists: (path) => exists(path),
            readDir: (path) => readDir(path),
            readTextFile: (path) => readTextFile(path),
            stat: async (path) => {
                const fileInfo = await stat(path);
                return {
                    mtime: fileInfo.mtime,
                    size: fileInfo.size,
                    isFile: fileInfo.isFile,
                    isDirectory: fileInfo.isDirectory,
                };
            },
        });
    }

    static async scanFile(config: ObsidianConfig, relativeFilePath: string): Promise<ObsidianFileScanResult> {
        if (!isTauriRuntime()) {
            return {
                tasks: [],
                warning: null,
                isTracked: false,
                relativeFilePath,
                detectedTaskNotes: false,
            };
        }

        const { exists, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
        return scanObsidianFile(config, relativeFilePath, {
            exists: (path) => exists(path),
            readTextFile: (path) => readTextFile(path),
            stat: async (path) => {
                const fileInfo = await stat(path);
                return {
                    mtime: fileInfo.mtime,
                    size: fileInfo.size,
                    isFile: fileInfo.isFile,
                    isDirectory: fileInfo.isDirectory,
                };
            },
        });
    }

    static async startWatcher(config: ObsidianConfig, handlers: ObsidianWatcherHandlers): Promise<void> {
        const normalized = normalizeObsidianConfig(config);
        const vaultPath = normalized.vaultPath;
        if (!isTauriRuntime() || !normalized.enabled || !vaultPath) {
            await ObsidianService.stopWatcher();
            return;
        }
        if (ObsidianService.watcherStop && ObsidianService.watcherVaultPath === vaultPath) {
            return;
        }

        await ObsidianService.stopWatcher();

        const { listen } = await import('@tauri-apps/api/event');
        const unlistenChanged = await listen<ObsidianFilesChangedPayload>(
            'obsidian:files-changed',
            (event) => {
                void handlers.onFilesChanged(event.payload);
            }
        );
        const unlistenError = await listen<ObsidianWatcherErrorPayload>(
            'obsidian:watcher-error',
            (event) => {
                const message = String(event.payload?.message || '').trim() || 'Live Obsidian updates are unavailable.';
                void handlers.onError(message);
            }
        );

        try {
            await tauriInvoke('start_obsidian_watcher', { vaultPath });
            ObsidianService.watcherVaultPath = vaultPath;
            ObsidianService.watcherStop = () => {
                unlistenChanged();
                unlistenError();
            };
        } catch (error) {
            unlistenChanged();
            unlistenError();
            throw error;
        }
    }

    static async stopWatcher(): Promise<void> {
        const stop = ObsidianService.watcherStop;
        ObsidianService.watcherStop = null;
        ObsidianService.watcherVaultPath = null;

        if (stop) {
            try {
                stop();
            } catch (error) {
                void logWarn('Failed to release Obsidian watcher listeners', {
                    scope: 'obsidian',
                    extra: {
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
            }
        }

        if (!isTauriRuntime()) return;
        try {
            await tauriInvoke('stop_obsidian_watcher');
        } catch (error) {
            void logWarn('Failed to stop Obsidian watcher', {
                scope: 'obsidian',
                extra: {
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }

    static buildObsidianUri(source: ObsidianSourceRef): string {
        return buildObsidianUri(source);
    }

    static async openInObsidian(source: ObsidianSourceRef): Promise<void> {
        const uri = buildObsidianUri(source);
        if (isTauriRuntime()) {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(uri);
            return;
        }
        window.open(uri, '_blank', 'noopener,noreferrer');
    }

    static async openTaskInObsidian(source: ObsidianSourceRef): Promise<void> {
        await ObsidianService.openInObsidian(source);
    }

    static async toggleTask(task: {
        vaultPath: string;
        relativeFilePath: string;
        lineNumber: number;
        taskText: string;
        setCompleted: boolean;
    }): Promise<void> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian write-back is only available on desktop.');
        }
        await tauriInvoke('obsidian_toggle_task', task);
    }

    static async toggleTaskNotesTask(task: {
        vaultPath: string;
        relativeFilePath: string;
        setCompleted: boolean;
    }): Promise<void> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian write-back is only available on desktop.');
        }
        await tauriInvoke('obsidian_toggle_tasknotes', task);
    }

    static async createTask(task: {
        vaultPath: string;
        relativeFilePath: string;
        taskText: string;
    }): Promise<void> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian task creation is only available on desktop.');
        }
        await tauriInvoke('obsidian_create_task', task);
    }

    static async createTaskNotesTask(task: {
        vaultPath: string;
        folder: string;
        title: string;
    }): Promise<string> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian task creation is only available on desktop.');
        }
        return tauriInvoke<string>('obsidian_create_tasknotes', task);
    }
}

export type { ObsidianConfig, ObsidianScanResult };
