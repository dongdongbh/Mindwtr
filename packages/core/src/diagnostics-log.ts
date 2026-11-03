


import { getBreadcrumbs } from './log-breadcrumbs';
import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';
import type { LogPayload } from './logger';
import type { AppData } from './types';


export const DIAGNOSTICS_LOG_RELATIVE_PATH = 'logs/mindwtr.log';

export const MAX_LOG_FILE_BYTES = 500_000;
export const ROTATED_LOG_RETAIN_CHARS = 250_000;

export const LOG_ROTATION_CHECK_INTERVAL = 50;

export type DiagnosticsLogLevel = 'info' | 'warn' | 'error';


export type DiagnosticsLogEntry = {
    ts: string;
    level: DiagnosticsLogLevel;
    scope: string;
    message: string;
    stack?: string;
    context?: Record<string, string>;
};


export type DiagnosticsLogOptions = { force?: boolean };


export type DiagnosticsLogClearResult = {
    outcome: 'cleared' | 'alreadyAbsent' | 'unavailable' | 'unconfirmed';
};

export const isDiagnosticsLoggingEnabled = (settings: AppData['settings'] | undefined): boolean =>
    settings?.diagnostics?.loggingEnabled === true;

export const formatDiagnosticsLogLine = (entry: DiagnosticsLogEntry): string => `${JSON.stringify(entry)}\n`;


export function buildDiagnosticsLogEntry(
    level: 'info' | 'warn',
    message: string,
    context?: { scope?: string; extra?: Record<string, unknown> },
): DiagnosticsLogEntry {
    const safeMessage = sanitizeForLog(message);
    return {
        ts: new Date().toISOString(),
        level,
        scope: context?.scope ?? level,
        message: safeMessage,
        context: sanitizeLogContext(context?.extra),
    };
}


export function buildDiagnosticsErrorEntry(
    error: unknown,
    context: { scope: string; url?: string; extra?: Record<string, unknown>; message?: string },
): DiagnosticsLogEntry {
    const rawMessage = context.message ?? (error instanceof Error ? error.message : String(error));
    const rawStack = error instanceof Error ? error.stack : undefined;
    const message = sanitizeForLog(rawMessage);
    const stack = rawStack ? sanitizeForLog(rawStack) : undefined;
    const breadcrumbs = getBreadcrumbs();
    const extra: Record<string, unknown> = {
        ...(context.extra ?? {}),
        ...(breadcrumbs.length > 0 ? { breadcrumbs: breadcrumbs.join(';') } : {}),
    };
    if (context.url) {
        const sanitizedUrl = sanitizeUrl(context.url);
        if (sanitizedUrl) {
            extra.url = sanitizedUrl;
        }
    }
    return {
        ts: new Date().toISOString(),
        level: 'error',
        scope: context.scope,
        message,
        stack,
        context: sanitizeLogContext(extra),
    };
}


export function buildCoreLogExtra(payload: Pick<LogPayload, 'category' | 'context' | 'error'>): Record<string, unknown> | undefined {
    const extra: Record<string, unknown> = {
        ...(payload.context ?? {}),
    };
    if (payload.category) {
        extra.category = payload.category;
    }
    if (payload.error) {
        extra.error = payload.error instanceof Error ? payload.error.message : String(payload.error);
        if (payload.error instanceof Error && payload.error.name) {
            extra.errorName = payload.error.name;
        }
        if (payload.error instanceof Error && payload.error.stack) {
            extra.errorStack = payload.error.stack;
        }
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
}


export function diagnosticsEntryFromLogPayload(payload: LogPayload): DiagnosticsLogEntry {
    const scope = payload.scope ?? 'core';
    const extra = buildCoreLogExtra(payload);
    if (payload.level === 'error') {
        return buildDiagnosticsErrorEntry(payload.error ?? payload.message, { scope, extra, message: payload.message });
    }
    return buildDiagnosticsLogEntry(payload.level, payload.message, { scope, extra });
}


export type DiagnosticsLogFile = {

    path(): Promise<string | null>;

    ensure(): Promise<string | null>;

    exists(): Promise<boolean>;

    isAbsent?(): Promise<boolean>;
    read(): Promise<string>;

    write(text: string): Promise<void>;

    delete(): Promise<boolean>;

    append?(line: string): Promise<boolean>;

    size?(): Promise<number>;

    moveAside?(): Promise<void>;
};

export type DiagnosticsLog = ReturnType<typeof createDiagnosticsLog>;


export function createDiagnosticsLog(options: { isEnabled: () => boolean; files: readonly DiagnosticsLogFile[] }) {
    const { files } = options;
    let writes = 0;
    let queue: Promise<unknown> = Promise.resolve();


    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
    };


    const trimIfNeeded = async (file: DiagnosticsLogFile, afterAppend: boolean): Promise<void> => {
        if (!file.size || !await file.exists()) return;
        if (!afterAppend && writes > 0 && writes % LOG_ROTATION_CHECK_INTERVAL !== 0) return;
        const size = await file.size();
        if (size <= MAX_LOG_FILE_BYTES) return;
        let current: string;
        try {
            current = await file.read();
        } catch {
            if (size > 2 * MAX_LOG_FILE_BYTES && file.moveAside) await file.moveAside();
            return;
        }
        await file.write(current.slice(-ROTATED_LOG_RETAIN_CHARS));
    };

    const writeLine = async (file: DiagnosticsLogFile, line: string): Promise<string | null> => {
        const path = await file.ensure();
        if (!path) return null;
        await trimIfNeeded(file, false);
        if (file.append && await file.append(line)) {
            writes += 1;

            await trimIfNeeded(file, true).catch(() => undefined);
            return path;
        }

        const current = await file.exists() ? await file.read() : '';
        let next = current + line;
        if (next.length > MAX_LOG_FILE_BYTES) {
            next = next.slice(-ROTATED_LOG_RETAIN_CHARS);
        }
        await file.write(next);
        writes += 1;
        return path;
    };


    const first = async <T>(operation: (file: DiagnosticsLogFile) => Promise<T | null>): Promise<T | null> => {
        for (const file of files) {
            try {
                const answer = await operation(file);
                if (answer !== null) return answer;
            } catch {

            }
        }
        return null;
    };

    return {
        serialize,

        append(entry: DiagnosticsLogEntry, appendOptions?: DiagnosticsLogOptions): Promise<string | null> {
            if (!appendOptions?.force && !options.isEnabled()) return Promise.resolve(null);
            const line = formatDiagnosticsLogLine(entry);
            return serialize(() => first((file) => writeLine(file, line)));
        },

        ensurePath(): Promise<string | null> {
            return first((file) => file.ensure());
        },

        path(): Promise<string | null> {
            return first((file) => file.path());
        },

        read(): Promise<string | null> {
            return serialize(async () => {
                for (const file of files) {
                    try {
                        if (!await file.exists()) continue;
                        return (await file.read()).trim() || null;
                    } catch {

                    }
                }
                return null;
            });
        },

        clear(): Promise<void> {
            return serialize(async () => {
                if (await first(async (file) => (await file.delete()) || null)) writes = 0;
            });
        },

        clearChecked(): Promise<DiagnosticsLogClearResult> {
            return serialize(async () => {
                const deleted = await first(async (file) => (await file.delete()) || null);
                if (deleted) writes = 0;
                let addressable = false;
                let confirmed = true;
                for (const file of files) {
                    try {
                        if (await file.path() === null) continue;
                        addressable = true;
                        if (!file.isAbsent || await file.isAbsent() !== true) confirmed = false;
                    } catch {
                        confirmed = false;
                    }
                }
                if (!confirmed) return { outcome: 'unconfirmed' };
                if (!addressable) return { outcome: 'unavailable' };
                return { outcome: deleted ? 'cleared' : 'alreadyAbsent' };
            });
        },
    };
}
