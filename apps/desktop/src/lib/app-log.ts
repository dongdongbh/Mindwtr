import { BaseDirectory, mkdir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { getBreadcrumbs, sanitizeForLog, sanitizeLogContext, sanitizeUrl, useTaskStore } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';

const LOG_DIR = 'mindwtr/logs';
const LOG_FILE = `${LOG_DIR}/mindwtr.log`;

type LogEntry = {
    ts: string;
    level: 'info' | 'warn' | 'error';
    scope: string;
    message: string;
    backend?: string;
    step?: string;
    url?: string;
    stack?: string;
    context?: Record<string, string>;
};

type AppendLogOptions = {
    force?: boolean;
};

export function sanitizeLogMessage(value: string): string {
    return sanitizeForLog(value);
}

async function ensureLogDir(): Promise<void> {
    await mkdir(LOG_DIR, { baseDir: BaseDirectory.Data, recursive: true });
}

function isLoggingEnabled(): boolean {
    if (isDiagnosticsEnabled()) return true;
    return useTaskStore.getState().settings.diagnostics?.loggingEnabled === true;
}

export function isDiagnosticsEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    return (window as any).__MINDWTR_DIAGNOSTICS__ === true;
}

async function appendLogLine(entry: LogEntry, options?: AppendLogOptions): Promise<string | null> {
    if (!options?.force && !isLoggingEnabled()) return null;
    if (!isTauriRuntime()) return null;
    try {
        const line = `${JSON.stringify(entry)}\n`;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            return await invoke<string>('append_log_line', { line });
        } catch (error) {
            try {
                await ensureLogDir();
                await writeTextFile(LOG_FILE, line, { baseDir: BaseDirectory.Data, append: true });
            } catch (writeError) {
                await ensureLogDir();
                await writeTextFile(LOG_FILE, line, { baseDir: BaseDirectory.Data });
            }
            return await getLogPath();
        }
    } catch (error) {
        return null;
    }
}

export async function getLogPath(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    try {
        const baseDir = await dataDir();
        return await join(baseDir, 'mindwtr', 'logs', 'mindwtr.log');
    } catch (error) {
        return null;
    }
}

export async function clearLog(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('clear_log_file');
    } catch (error) {
        try {
            await remove(LOG_FILE, { baseDir: BaseDirectory.Data, recursive: false });
        } catch (_removeError) {
            return;
        }
    }
}

export async function logError(
    error: unknown,
    context: { scope: string; step?: string; url?: string; extra?: Record<string, unknown>; force?: boolean; message?: string }
): Promise<string | null> {
    const rawMessage = context.message ?? (error instanceof Error ? error.message : String(error));
    const rawStack = error instanceof Error ? error.stack : undefined;
    const message = sanitizeForLog(rawMessage);
    const stack = rawStack ? sanitizeForLog(rawStack) : undefined;
    const extra = {
        ...(context.extra ?? {}),
        ...(getBreadcrumbs().length > 0 ? { breadcrumbs: getBreadcrumbs().join(';') } : {}),
    };

    return appendLogLine({
        ts: new Date().toISOString(),
        level: 'error',
        scope: context.scope,
        message,
        step: context.step,
        url: sanitizeUrl(context.url),
        stack,
        context: sanitizeLogContext(extra),
    }, { force: context.force });
}

export async function logInfo(
    message: string,
    context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }
): Promise<string | null> {
    const safeMessage = sanitizeForLog(message);
    return appendLogLine({
        ts: new Date().toISOString(),
        level: 'info',
        scope: context?.scope ?? 'info',
        message: safeMessage,
        context: sanitizeLogContext(context?.extra),
    }, { force: context?.force });
}

export async function logWarn(
    message: string,
    context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }
): Promise<string | null> {
    const safeMessage = sanitizeForLog(message);
    return appendLogLine({
        ts: new Date().toISOString(),
        level: 'warn',
        scope: context?.scope ?? 'warn',
        message: safeMessage,
        context: sanitizeLogContext(context?.extra),
    }, { force: context?.force });
}

export async function logSyncError(
    error: unknown,
    context: { backend: string; step: string; url?: string }
): Promise<string | null> {
    return logError(error, {
        scope: 'sync',
        step: context.step,
        url: context.url,
        extra: { backend: context.backend },
    });
}

let globalHandlersAttached = false;

export function setupGlobalErrorLogging(): void {
    if (!isTauriRuntime()) return;
    if (globalHandlersAttached) return;
    if (typeof window === 'undefined') return;
    globalHandlersAttached = true;

    window.addEventListener('error', (event) => {
        void logError(event.error || event.message, {
            scope: 'window',
            step: 'error',
            extra: {
                source: event.filename || 'unknown',
                line: String(event.lineno ?? ''),
                column: String(event.colno ?? ''),
            },
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        void logError(event.reason, { scope: 'unhandledrejection' });
    });

}
