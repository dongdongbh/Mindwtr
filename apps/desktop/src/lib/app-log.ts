import { mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import {
    buildFeedbackDiagnostics,
    createFeedbackDiagnosticsBuffer,
    FEEDBACK_DIAGNOSTICS_SOURCE_CHARS,
    getBreadcrumbs,
    sanitizeForLog,
    sanitizeLogContext,
    sanitizeUrl,
    type DiagnosticsSettings,
    useTaskStore,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { getDeviceManagedPath } from './managed-paths';

const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'mindwtr.log';
const RECENT_LOG_MAX_CHARS = 20_000;
const feedbackDiagnosticsBuffer = createFeedbackDiagnosticsBuffer();

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
    const logDir = await getDeviceManagedPath(LOG_DIR_NAME);
    await mkdir(logDir, { recursive: true });
    return logDir;
}

export function isLoggingEnabled(): boolean {
    if (isDiagnosticsEnabled()) return true;
    const diagnostics: DiagnosticsSettings | undefined = useTaskStore.getState().settings.diagnostics;
    return diagnostics?.loggingEnabled === true;
}

export function isDiagnosticsEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    return (window as any).__MINDWTR_DIAGNOSTICS__ === true;
}

async function appendLogLine(entry: LogEntry, options?: AppendLogOptions): Promise<string | null> {
    feedbackDiagnosticsBuffer.record(entry);
    if (!options?.force && !isLoggingEnabled()) return null;
    if (!isTauriRuntime()) return null;
    try {
        const line = `${JSON.stringify(entry)}\n`;
        try {
            return await invokeNative<string>('append_log_line', { line });
        } catch (error) {


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


        const nativePath = (await invokeNative<string>('get_log_file_path')).trim();
        if (nativePath) return nativePath;
    } catch {

    }
    try {
        return await getDeviceManagedPath(LOG_DIR_NAME, LOG_FILE_NAME);
    } catch (error) {
        return null;
    }
}

export async function clearLog(): Promise<void> {
    feedbackDiagnosticsBuffer.clear();
    if (!isTauriRuntime()) return;
    try {
        await invokeNative('clear_log_file');
    } catch (error) {
        try {
            const logFile = await getDeviceManagedPath(LOG_DIR_NAME, LOG_FILE_NAME);
            await remove(logFile, { recursive: false });
        } catch (_removeError) {
            return;
        }
    }
}

export type SaveLogCopyResult = 'saved' | 'cancelled' | 'missing';


export async function saveLogCopy(): Promise<SaveLogCopyResult> {
    if (!isTauriRuntime()) return 'missing';
    const logFile = await getLogPath();
    if (!logFile) return 'missing';
    const readOrEmpty = async (path: string) => {
        try {
            return await readTextFile(path);
        } catch {
            return '';
        }
    };
    const parts = [await readOrEmpty(`${logFile}.1`), await readOrEmpty(logFile)]
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length === 0) return 'missing';

    const { save } = await import('./native-dialog');
    const selected = await save({
        defaultPath: LOG_FILE_NAME,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    });
    if (!selected || typeof selected !== 'string') return 'cancelled';
    await writeTextFile(selected, `${parts.join('\n')}\n`);
    return 'saved';
}

export async function readRecentLogText(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    try {
        const logFile = await getLogPath();
        if (!logFile) return null;
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


    const snapshot = JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'feedback',
        message: 'Feedback diagnostics snapshot',
        context: sanitizeLogContext({
            debugLoggingEnabled: isLoggingEnabled(),
            releaseCheck: 'v1.3.0/feedback-diagnostics',
            captureMode: 'recent-session-and-saved-log',
            breadcrumbCount: breadcrumbs.length,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs.join(';') : 'none',
        }),
    });
    const recentLogs = await readRecentLogText(FEEDBACK_DIAGNOSTICS_SOURCE_CHARS);
    return buildFeedbackDiagnostics([recentLogs, feedbackDiagnosticsBuffer.read()], snapshot, maxChars);
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
