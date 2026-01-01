import { BaseDirectory, mkdir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { useTaskStore } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';

const APP_NAME = 'mindwtr';
const LOG_DIR = `${APP_NAME}/logs`;
const LOG_FILE = `${LOG_DIR}/mindwtr.log`;

type LogEntry = {
    ts: string;
    level: 'info' | 'error';
    scope: string;
    message: string;
    backend?: string;
    step?: string;
    url?: string;
    stack?: string;
    context?: Record<string, string>;
};

const SENSITIVE_KEYS = ['token', 'access_token', 'password', 'pass', 'apikey', 'api_key', 'key', 'auth', 'authorization', 'username', 'user'];

function redactSensitiveText(value: string): string {
    let result = value;
    result = result.replace(/(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+\/=._-]+/gi, '$1$2 [redacted]');
    result = result.replace(
        /(password|pass|token|access_token|api_key|apikey|authorization|username|user)=([^\s&]+)/gi,
        '$1=[redacted]'
    );
    result = result.replace(/https?:\/\/[^\s'")]+/gi, (match) => sanitizeUrl(match) ?? match);
    return result;
}

export function sanitizeLogMessage(value: string): string {
    return redactSensitiveText(value);
}

function sanitizeContext(context?: Record<string, string>): Record<string, string> | undefined {
    if (!context) return undefined;
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(context)) {
        const keyLower = key.toLowerCase();
        if (SENSITIVE_KEYS.some((s) => keyLower.includes(s))) {
            sanitized[key] = '[redacted]';
        } else {
            sanitized[key] = redactSensitiveText(String(value));
        }
    }
    return sanitized;
}

function sanitizeUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        parsed.username = '';
        parsed.password = '';
        const params = parsed.searchParams;
        for (const key of params.keys()) {
            const keyLower = key.toLowerCase();
            if (SENSITIVE_KEYS.some((s) => keyLower.includes(s))) {
                params.set(key, 'redacted');
            }
        }
        return parsed.toString();
    } catch {
        return raw;
    }
}

async function ensureLogDir(): Promise<void> {
    await mkdir(LOG_DIR, { baseDir: BaseDirectory.Data, recursive: true });
}

function isLoggingEnabled(): boolean {
    return useTaskStore.getState().settings.diagnostics?.loggingEnabled === true;
}

async function appendLogLine(entry: LogEntry): Promise<string | null> {
    if (!isLoggingEnabled()) return null;
    if (!isTauriRuntime()) return null;
    try {
        await ensureLogDir();
        const line = `${JSON.stringify(entry)}\n`;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            return await invoke<string>('append_log_line', { line });
        } catch (error) {
            try {
                await writeTextFile(LOG_FILE, line, { baseDir: BaseDirectory.Data, append: true });
            } catch (writeError) {
                await writeTextFile(LOG_FILE, line, { baseDir: BaseDirectory.Data });
            }
            return await getLogPath();
        }
    } catch (error) {
        console.warn('Failed to write log', error);
        return null;
    }
}

export async function getLogPath(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    try {
        const baseDir = await dataDir();
        return await join(baseDir, APP_NAME, 'logs', 'mindwtr.log');
    } catch (error) {
        console.warn('Failed to resolve log path', error);
        return null;
    }
}

export async function clearLog(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        await remove(LOG_FILE, { baseDir: BaseDirectory.Data, recursive: false });
    } catch (error) {
        console.warn('Failed to clear log', error);
    }
}

export async function logError(
    error: unknown,
    context: { scope: string; step?: string; url?: string; extra?: Record<string, string> }
): Promise<string | null> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawStack = error instanceof Error ? error.stack : undefined;
    const message = redactSensitiveText(rawMessage);
    const stack = rawStack ? redactSensitiveText(rawStack) : undefined;

    return appendLogLine({
        ts: new Date().toISOString(),
        level: 'error',
        scope: context.scope,
        message,
        step: context.step,
        url: sanitizeUrl(context.url),
        stack,
        context: sanitizeContext(context.extra),
    });
}

export async function logInfo(
    message: string,
    context?: { scope?: string; extra?: Record<string, string> }
): Promise<string | null> {
    const safeMessage = redactSensitiveText(message);
    return appendLogLine({
        ts: new Date().toISOString(),
        level: 'info',
        scope: context?.scope ?? 'info',
        message: safeMessage,
        context: sanitizeContext(context?.extra),
    });
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
