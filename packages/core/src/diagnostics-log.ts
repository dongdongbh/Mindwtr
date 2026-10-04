/**
 * The diagnostics log file (Settings › Data › Debug logging), shared by the React Native app
 * (apps/mobile/lib/app-log.ts) and the native hosts: where the file lives, when a line is
 * written, the line's format and sanitizing, the size cap, and the order of writes.
 *
 * Each app gives its file access as DiagnosticsLogFile. A log tries its files in order, best
 * first: an unavailable or failing file hands the operation to the next one (React Native lists
 * Expo's file API, then its legacy one).
 */
import { getBreadcrumbs } from './log-breadcrumbs';
import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';
import type { LogPayload } from './logger';
import type { AppData } from './types';

/** The log file, relative to the app's documents directory (Expo's `Paths.document`, Android's `files/`). */
export const DIAGNOSTICS_LOG_RELATIVE_PATH = 'logs/mindwtr.log';
/** Past this size the file keeps only its last ROTATED_LOG_RETAIN_CHARS characters. */
export const MAX_LOG_FILE_BYTES = 500_000;
export const ROTATED_LOG_RETAIN_CHARS = 250_000;
/** Before an append, the size is checked on every 50th write; after an append, always. */
export const LOG_ROTATION_CHECK_INTERVAL = 50;

export type DiagnosticsLogLevel = 'info' | 'warn' | 'error';

/** One line of the file, as JSON in this key order. */
export type DiagnosticsLogEntry = {
    ts: string;
    level: DiagnosticsLogLevel;
    scope: string;
    message: string;
    stack?: string;
    context?: Record<string, string>;
};

/** `force` writes the line while debug logging is off. */
export type DiagnosticsLogOptions = { force?: boolean };

/** Checked Clear proves absence when the file port supports a strict entry probe. */
export type DiagnosticsLogClearResult = {
    outcome: 'cleared' | 'alreadyAbsent' | 'unavailable' | 'unconfirmed';
};

export const isDiagnosticsLoggingEnabled = (settings: AppData['settings'] | undefined): boolean =>
    settings?.diagnostics?.loggingEnabled === true;

export const formatDiagnosticsLogLine = (entry: DiagnosticsLogEntry): string => `${JSON.stringify(entry)}\n`;

/** An info or warning line: the message and `extra` sanitized; the scope defaults to the level. */
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

/** An error line: the message (or [error]'s), its stack, `extra`, the breadcrumbs and a credential-free `url`, all sanitized. */
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

/** A core logger payload's context for its line: its context, its category, and its error's message, name and stack. */
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

/** The line for a core logger payload (setLogger); its scope defaults to 'core'. Pass `payload.force` on to append. */
export function diagnosticsEntryFromLogPayload(payload: LogPayload): DiagnosticsLogEntry {
    const scope = payload.scope ?? 'core';
    const extra = buildCoreLogExtra(payload);
    if (payload.level === 'error') {
        return buildDiagnosticsErrorEntry(payload.error ?? payload.message, { scope, extra, message: payload.message });
    }
    return buildDiagnosticsLogEntry(payload.level, payload.message, { scope, extra });
}

/**
 * One place an app can keep the log file. A method that throws hands the operation to the log's
 * next file. Without `append` every line rewrites the file; without `size` the file is trimmed
 * only by those rewrites.
 */
export type DiagnosticsLogFile = {
    /** The file's path or URI, whether or not it exists; null when unknown. */
    path(): Promise<string | null>;
    /** Makes the directory and an empty file when missing: the path, or null when this file cannot be used. */
    ensure(): Promise<string | null>;
    /** Whether the file is there (a directory in its place is not). */
    exists(): Promise<boolean>;
    /** True only when no entry exists at the main target; a directory is present and uncertain I/O throws. */
    isAbsent?(): Promise<boolean>;
    read(): Promise<string>;
    /** Replaces the whole file. */
    write(text: string): Promise<void>;
    /** Deletes the file; false when this file had nothing to delete (the next file is tried). */
    delete(): Promise<boolean>;
    /** Adds [line] at the end; false when it could not (the line rewrites the file instead). */
    append?(line: string): Promise<boolean>;
    /** The size in bytes. */
    size?(): Promise<number>;
    /** Moves the file to `<its path>.unreadable`, replacing an older one; the next line starts a new file. */
    moveAside?(): Promise<void>;
};

export type DiagnosticsLog = ReturnType<typeof createDiagnosticsLog>;

/** A log over [files], writing while [isEnabled] (the app's debug logging setting) or when forced. */
export function createDiagnosticsLog(options: { isEnabled: () => boolean; files: readonly DiagnosticsLogFile[] }) {
    const { files } = options;
    let writes = 0;
    let queue: Promise<unknown> = Promise.resolve();

    /** Runs [task] after every earlier write, read and clear, and before any later one. */
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
    };

    /**
     * Keeps the file's last ROTATED_LOG_RETAIN_CHARS characters once it passes the cap. A file that cannot be read (on RN, one
     * that is not valid UTF-8) is left as it is and logging goes on: trimming '' would erase it, and throwing stopped every
     * later line. Past twice the cap it is moved aside whole, so the log stays bounded, and a new file starts.
     */
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
            // The line is written: a failed trim must not hand it to the next file, which would write it again.
            await trimIfNeeded(file, true).catch(() => undefined);
            return path;
        }
        // A failed read throws, so the line goes to the next file or is dropped: rewriting from '' would erase the log.
        const current = await file.exists() ? await file.read() : '';
        let next = current + line;
        if (next.length > MAX_LOG_FILE_BYTES) {
            next = next.slice(-ROTATED_LOG_RETAIN_CHARS);
        }
        await file.write(next);
        writes += 1;
        return path;
    };

    /** The first file whose [operation] gives an answer; a file that throws or answers null is skipped. */
    const first = async <T>(operation: (file: DiagnosticsLogFile) => Promise<T | null>): Promise<T | null> => {
        for (const file of files) {
            try {
                const answer = await operation(file);
                if (answer !== null) return answer;
            } catch {
                // The next file.
            }
        }
        return null;
    };

    return {
        serialize,
        /** Writes [entry]'s line; the file's path, or null when nothing was written. */
        append(entry: DiagnosticsLogEntry, appendOptions?: DiagnosticsLogOptions): Promise<string | null> {
            if (!appendOptions?.force && !options.isEnabled()) return Promise.resolve(null);
            const line = formatDiagnosticsLogLine(entry);
            return serialize(() => first((file) => writeLine(file, line)));
        },
        /** The file's path, made first when missing (for sharing); null when no file can be made. */
        ensurePath(): Promise<string | null> {
            return first((file) => file.ensure());
        },
        /** Where the file is or would be; nothing is made. */
        path(): Promise<string | null> {
            return first((file) => file.path());
        },
        /** The file's text, trimmed; null when it is missing or empty. */
        read(): Promise<string | null> {
            return serialize(async () => {
                for (const file of files) {
                    try {
                        if (!await file.exists()) continue;
                        return (await file.read()).trim() || null;
                    } catch {
                        // The next file.
                    }
                }
                return null;
            });
        },
        /** Deletes the file. */
        clear(): Promise<void> {
            return serialize(async () => {
                if (await first(async (file) => (await file.delete()) || null)) writes = 0;
            });
        },
        /** Deletes the main log, then verifies every addressable target in the same queue operation. */
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
