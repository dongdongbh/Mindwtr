export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'network' | 'validation' | 'permissions' | 'storage' | 'sync' | 'fts' | 'unknown';

export type LogMeta = {
    scope?: string;
    category?: LogCategory;
    context?: Record<string, unknown>;
    error?: unknown;
};

export type LogPayload = LogMeta & {
    level: LogLevel;
    message: string;
};

export type Logger = (payload: LogPayload) => void;
export { sanitizeForLog, sanitizeLogContext, sanitizeLogMessage, sanitizeUrl } from './log-sanitize';

const normalizeError = (error: unknown): Record<string, unknown> | undefined => {
    if (!error) return undefined;
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return { error };
};

import { sanitizeForLog, sanitizeLogContext } from './log-sanitize';

export const consoleLogger: Logger = (payload) => {
    const { level, message, error, ...rest } = payload;
    const entry = {
        ...sanitizeLogContext(rest as Record<string, unknown>),
        ...(error ? { error: sanitizeLogContext(normalizeError(error)) } : {}),
    };
    const safeMessage = sanitizeForLog(message);
    if (level === 'error') {
        console.error(safeMessage, entry);
        return;
    }
    if (level === 'warn') {
        console.warn(safeMessage, entry);
        return;
    }
    console.info(safeMessage, entry);
};

let logger: Logger = consoleLogger;

export const setLogger = (next: Logger) => {
    logger = next;
};

export const logInfo = (message: string, meta?: LogMeta) => logger({ level: 'info', message, ...meta });
export const logWarn = (message: string, meta?: LogMeta) => logger({ level: 'warn', message, ...meta });
export const logError = (message: string, meta?: LogMeta) => logger({ level: 'error', message, ...meta });
