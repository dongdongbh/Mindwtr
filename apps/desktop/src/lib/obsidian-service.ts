import { appendObsidianRequiredInlineTag, type ObsidianSourceRef } from '@mindwtr/core';
import { getDesktopTimerHost, isTauriRuntime } from './runtime';
import { reportError } from './report-error';
import { invokeNative, invokeNativeOr } from './tauri-invoke';
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
const FORBIDDEN_PATH_RETRY_DELAYS_MS = [75, 250, 500];

export type ObsidianFilesChangedPayload = {
    changed: string[];
    deleted: string[];
};

/** Mirrors the Rust `DetectedObsidianVault` returned by `list_obsidian_vaults`. */
export type DetectedObsidianVault = {
    name: string;
    path: string;
};

type ObsidianWatcherErrorPayload = {
    message?: string;
};

type ObsidianWatcherHandlers = {
    onFilesChanged: (payload: ObsidianFilesChangedPayload) => void | Promise<void>;
    onError: (message: string) => void | Promise<void>;
};

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

const toErrorText = (error: unknown): string => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return String(error || '').trim();
};

const isForbiddenPathError = (error: unknown): boolean => {
    return /forbidden path/i.test(toErrorText(error));
};

const sleep = (delayMs: number): Promise<void> => {
    if (delayMs <= 0) return Promise.resolve();
    const timers = getDesktopTimerHost();
    return new Promise((resolve) => {
        timers.setTimeout(resolve, delayMs);
    });
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

/**
 * Vaults Obsidian has registered on this machine. Empty off-Tauri or when the
 * registry cannot be read — the caller offers filesystem browsing either way.
 */
export const listDetectedObsidianVaults = async (): Promise<DetectedObsidianVault[]> => {
    try {
        const vaults = await invokeNativeOr<DetectedObsidianVault[]>([], 'list_obsidian_vaults');
        return Array.isArray(vaults) ? vaults : [];
    } catch {
        return [];
    }
};

export class ObsidianService {
    private static watcherStop: (() => void) | null = null;

    private static watcherVaultPath: string | null = null;

    private static async expandVaultScope(vaultPath: string | null): Promise<void> {
        const trimmed = String(vaultPath || '').trim();
        if (!trimmed || !isTauriRuntime()) return;
        try {
            await invokeNative<boolean>('expand_obsidian_vault_scope', { vaultPath: trimmed });
        } catch (error) {
            void logWarn('Failed to expand Obsidian vault filesystem scope', {
                scope: 'obsidian',
                extra: {
                    vaultPath: trimmed,
                    error: toErrorText(error),
                },
            });
        }
    }

    private static async withForbiddenPathRetry<T>(vaultPath: string | null, work: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await work();
            } catch (error) {
                const delayMs = FORBIDDEN_PATH_RETRY_DELAYS_MS[attempt];
                if (!isForbiddenPathError(error) || delayMs === undefined) {
                    throw error;
                }
                await ObsidianService.expandVaultScope(vaultPath);
                await sleep(delayMs);
            }
        }
    }

    static async getConfig(): Promise<ObsidianConfig> {
        if (!isTauriRuntime()) {
            return readStoredConfig();
        }

        try {
            return normalizeObsidianConfig(await invokeNative<Partial<ObsidianConfig>>('get_obsidian_config'));
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
            const saved = await invokeNative<Partial<ObsidianConfig>>('set_obsidian_config', { config: normalized });
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
            return await invokeNative<boolean>('check_obsidian_vault_marker', { vaultPath: trimmed });
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

        const normalizedConfig = normalizeObsidianConfig(config);
        return ObsidianService.withForbiddenPathRetry(normalizedConfig.vaultPath, async () => {
            const { exists, readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
            return scanObsidianVault(normalizedConfig, {
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

        const normalizedConfig = normalizeObsidianConfig(config);
        return ObsidianService.withForbiddenPathRetry(normalizedConfig.vaultPath, async () => {
            const { exists, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
            return scanObsidianFile(normalizedConfig, relativeFilePath, {
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
            await invokeNative('start_obsidian_watcher', { vaultPath });
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
            await invokeNative('stop_obsidian_watcher');
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
        await invokeNative('obsidian_toggle_task', task);
    }

    static async toggleTaskNotesTask(task: {
        vaultPath: string;
        relativeFilePath: string;
        setCompleted: boolean;
    }): Promise<void> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian write-back is only available on desktop.');
        }
        await invokeNative('obsidian_toggle_tasknotes', task);
    }

    static async createTask(task: {
        requiredInlineTag?: string;
        vaultPath: string;
        relativeFilePath: string;
        taskText: string;
    }): Promise<void> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian task creation is only available on desktop.');
        }
        const { requiredInlineTag = '', ...payload } = task;
        await invokeNative('obsidian_create_task', {
            ...payload, taskText: appendObsidianRequiredInlineTag(task.taskText, requiredInlineTag),
        });
    }

    static async createTaskNotesTask(task: {
        vaultPath: string;
        folder: string;
        title: string;
    }): Promise<string> {
        if (!isTauriRuntime()) {
            throw new Error('Obsidian task creation is only available on desktop.');
        }
        return invokeNative<string>('obsidian_create_tasknotes', task);
    }
}

export type { ObsidianConfig, ObsidianScanResult };
