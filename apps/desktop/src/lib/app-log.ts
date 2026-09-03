import { mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import {
    getBreadcrumbs,
    sanitizeForLog,
    sanitizeLogContext,
    sanitizeUrl,
    type DiagnosticsSettings,
    useTaskStore,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { getManagedPath } from './managed-paths';

const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'mindwtr.log';
const RECENT_LOG_MAX_CHARS = 20_000;

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

async function ensureLogDir(): Promise<string> {
    const logDir = await getManagedPath(LOG_DIR_NAME);
    await mkdir(logDir, { recursive: true });
    return logDir;
}

function isLoggingEnabled(): boolean {
    if (isDiagnosticsEnabled()) return true;
    const diagnostics: DiagnosticsSettings | undefined = useTaskStore.getState().settings.diagnostics;
    return diagnostics?.loggingEnabled === true;
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
            return await invokeNative<string>('append_log_line', { line });
        } catch (error) {
            // No non-append retry: writeTextFile without `append` replaces the
            // whole file, so a failed append used to throw away every line
            // logged so far to save the one that just failed.
            const logDir = await ensureLogDir();
            const logFile = await join(logDir, LOG_FILE_NAME);
            await writeTextFile(logFile, line, { append: true });
            return logFile;
        }
    } catch (error) {
        return null;
    }
}

export async function getLogPath(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    try {
        // The backend knows where the file really lands (MS Store installs get
        // their AppData writes redirected into the package LocalCache, #1135).
        const nativePath = (await invokeNative<string>('get_log_file_path')).trim();
        if (nativePath) return nativePath;
    } catch {
        // Older backend without the command — fall back to the computed path.
    }
    try {
        return await getManagedPath(LOG_DIR_NAME, LOG_FILE_NAME);
    } catch (error) {
        return null;
    }
}

export async function clearLog(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        await invokeNative('clear_log_file');
    } catch (error) {
        try {
            const logFile = await getManagedPath(LOG_DIR_NAME, LOG_FILE_NAME);
            await remove(logFile, { recursive: false });
        } catch (_removeError) {
            return;
        }
    }
}

export async function readRecentLogText(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    try {
        const logFile = await getManagedPath(LOG_DIR_NAME, LOG_FILE_NAME);
        const raw = await readTextFile(logFile);
        const trimmed = raw.trim();
        if (!trimmed) return null;
        return trimmed.slice(-Math.max(1, maxChars));
    } catch {
        return null;
    }
}

export async function collectFeedbackDiagnostics(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
    const breadcrumbs = getBreadcrumbs();
    // Feedback attachment is an explicit, one-time opt-in. Build the snapshot in
    // memory so checking the box does not persist a log when detailed logging is
    // disabled, while still explaining the recent app flow.
    const snapshot = JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'feedback',
        message: 'Feedback diagnostics snapshot',
        context: sanitizeLogContext({
            debugLoggingEnabled: isLoggingEnabled(),
            breadcrumbCount: breadcrumbs.length,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs.join(';') : 'none',
        }),
    });
    const recentLogs = await readRecentLogText(maxChars);
    return `${recentLogs ? `${recentLogs}\n` : ''}${snapshot}`.slice(-Math.max(1, maxChars));
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
