import { getBreadcrumbs, sanitizeForLog, sanitizeLogContext, sanitizeUrl, useTaskStore } from '@mindwtr/core';
import * as ExpoLegacyFileSystem from 'expo-file-system/legacy';

type ExpoDirectory = {
  exists: boolean;
  create: (options: { intermediates?: boolean; idempotent?: boolean }) => void;
  delete: () => void;
  info?: () => { exists?: boolean };
  uri: string;
};

type ExpoFile = {
  exists: boolean;
  create: (options: { intermediates?: boolean; overwrite?: boolean }) => void;
  delete: () => void;
  info?: () => { exists?: boolean; size?: number };
  open?: () => ExpoFileHandle;
  size?: number;
  write: (content: string, options?: { encoding?: string }) => void;
  text: () => Promise<string>;
  uri: string;
};

type ExpoFileHandle = {
  close: () => void;
  offset: number | null;
  size: number | null;
  writeBytes: (bytes: Uint8Array) => void;
};

type ExpoFileSystemModule = {
  Directory: new (uri: string) => ExpoDirectory;
  File: new (uri: string) => ExpoFile;
  Paths: { document?: { uri: string } };
};

type ExpoLegacyFileSystemModule = {
  documentDirectory: string | null;
  deleteAsync: (fileUri: string, options?: { idempotent?: boolean }) => Promise<void>;
  getInfoAsync: (fileUri: string) => Promise<{ exists: boolean; isDirectory?: boolean; size?: number }>;
  makeDirectoryAsync: (fileUri: string, options?: { intermediates?: boolean }) => Promise<void>;
  readAsStringAsync: (fileUri: string, options?: { encoding?: string }) => Promise<string>;
  writeAsStringAsync: (fileUri: string, contents: string, options?: { encoding?: string }) => Promise<void>;
};

let expoFileSystemModule: ExpoFileSystemModule | null | undefined;
let expoLegacyFileSystemModule: ExpoLegacyFileSystemModule | null | undefined = ExpoLegacyFileSystem as unknown as ExpoLegacyFileSystemModule;
let logTargetsInitialized = false;
let LOG_DIR: ExpoDirectory | null = null;
let LOG_FILE: ExpoFile | null = null;
let LOG_DIR_URI: string | null = null;
let LOG_FILE_URI: string | null = null;
let logWriteCount = 0;

const getExpoFileSystem = async (): Promise<ExpoFileSystemModule | null> => {
  if (expoFileSystemModule !== undefined) return expoFileSystemModule;
  try {
    expoFileSystemModule = (await import('expo-file-system')) as unknown as ExpoFileSystemModule;
  } catch {
    expoFileSystemModule = null;
  }
  return expoFileSystemModule;
};

const getLegacyFileSystem = async (): Promise<ExpoLegacyFileSystemModule | null> => {
  if (expoLegacyFileSystemModule !== undefined) return expoLegacyFileSystemModule;
  try {
    expoLegacyFileSystemModule = (await import('expo-file-system/legacy')) as unknown as ExpoLegacyFileSystemModule;
  } catch (error) {
    logInternalFailure('load legacy file system', error);
    expoLegacyFileSystemModule = null;
  }
  return expoLegacyFileSystemModule;
};

const logInternalFailure = (phase: string, error?: unknown): void => {
  if (!__DEV__) return;
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  // Console is the only reliable fallback when the diagnostics file itself is unavailable.
  console.warn(`[Mindwtr diagnostics] ${phase} failed: ${message}`);
};

const logEntryToDevConsole = (entry: LogEntry): void => {
  if (!__DEV__) return;
  const context = entry.context && Object.keys(entry.context).length > 0
    ? ` ${JSON.stringify(entry.context)}`
    : '';
  const line = `[Mindwtr ${entry.scope}] ${entry.message}${context}`;
  if (entry.level === 'error') {
    console.error(line);
  } else if (entry.level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
};

const buildLegacyTargets = (documentDirectory?: string | null): { dirUri: string; fileUri: string } | null => {
  if (!documentDirectory) return null;
  const baseUri = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
  const dirUri = `${baseUri}logs`;
  return { dirUri, fileUri: `${dirUri}/mindwtr.log` };
};

const ensureLogTargets = async (): Promise<void> => {
  if (logTargetsInitialized && LOG_DIR && LOG_FILE) return;
  try {
    const fs = await getExpoFileSystem();
    const baseUri = fs?.Paths?.document?.uri;
    if (!fs || !baseUri) {
      logTargetsInitialized = false;
      return;
    }
    const normalizedBase = baseUri.endsWith('/') ? baseUri : `${baseUri}/`;
    LOG_DIR_URI = `${normalizedBase}logs`;
    LOG_FILE_URI = `${LOG_DIR_URI}/mindwtr.log`;
    LOG_DIR = new fs.Directory(LOG_DIR_URI);
    LOG_FILE = new fs.File(LOG_FILE_URI);
    logTargetsInitialized = true;
  } catch {
    logTargetsInitialized = false;
    LOG_DIR = null;
    LOG_FILE = null;
    LOG_DIR_URI = null;
    LOG_FILE_URI = null;
  }
};
const MAX_LOG_FILE_BYTES = 500_000;
const ROTATED_LOG_RETAIN_CHARS = 250_000;
const LOG_ROTATION_CHECK_INTERVAL = 50;
const RECENT_LOG_MAX_CHARS = 20_000;
const UTF8_ENCODING = 'utf8';

type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  stack?: string;
  context?: Record<string, string>;
};

export type LogBackend = {
  appendLogLine?: (
    entry: {
      ts: string;
      level: 'info' | 'warn' | 'error';
      scope: string;
      message: string;
      stack?: string;
      context?: Record<string, string>;
    },
    options?: { force?: boolean }
  ) => Promise<string | null>;
  getLogPath?: () => Promise<string | null>;
  ensureLogFilePath?: () => Promise<string | null>;
  clearLog?: () => Promise<void>;
};

let customLogBackend: LogBackend | null = null;
let logWriteQueue: Promise<void> = Promise.resolve();

export function setLogBackend(backend: LogBackend | null): void {
  customLogBackend = backend;
}

export function sanitizeLogMessage(value: string): string {
  return sanitizeForLog(value);
}

async function ensureLogDir(): Promise<void> {
  await ensureLogTargets();
  if (!LOG_DIR) return;
  if (!directoryExists(LOG_DIR)) {
    LOG_DIR.create({ intermediates: true, idempotent: true });
  }
}

function directoryExists(directory: ExpoDirectory | null): boolean {
  if (!directory) return false;
  try {
    const info = directory.info?.();
    if (typeof info?.exists === 'boolean') return info.exists;
  } catch {
  }
  return directory.exists;
}

function fileExists(file: ExpoFile | null): boolean {
  if (!file) return false;
  try {
    const info = file.info?.();
    if (typeof info?.exists === 'boolean') return info.exists;
  } catch {
  }
  return file.exists;
}

async function ensureLogFile(): Promise<boolean> {
  await ensureLogTargets();
  if (!LOG_DIR || !LOG_FILE) return false;
  if (!directoryExists(LOG_DIR)) {
    LOG_DIR.create({ intermediates: true, idempotent: true });
  }
  if (!fileExists(LOG_FILE)) {
    try {
      LOG_FILE.create({ intermediates: true, overwrite: true });
    } catch (error) {
      // If a directory exists where the log file should be, remove it and retry.
      const fs = await getExpoFileSystem();
      if (LOG_FILE_URI && LOG_DIR_URI && LOG_FILE_URI !== fs?.Paths?.document?.uri && fs) {
        const strayDir = new fs.Directory(LOG_FILE_URI);
        if (strayDir.exists) {
          try {
            strayDir.delete();
          } catch (deleteError) {
            return false;
          }
        }
        LOG_FILE.create({ intermediates: true, overwrite: true });
      } else {
        logInternalFailure('create log file', error);
        return false;
      }
    }
  }
  return fileExists(LOG_FILE);
}

async function ensureLegacyLogFilePath(): Promise<string | null> {
  try {
    const fs = await getLegacyFileSystem();
    const targets = buildLegacyTargets(fs?.documentDirectory);
    if (!fs || !targets) return null;
    const dirInfo = await fs.getInfoAsync(targets.dirUri);
    if (!dirInfo.exists) {
      await fs.makeDirectoryAsync(targets.dirUri, { intermediates: true });
    } else if (dirInfo.isDirectory === false) {
      return null;
    }
    const fileInfo = await fs.getInfoAsync(targets.fileUri);
    if (!fileInfo.exists) {
      await fs.writeAsStringAsync(targets.fileUri, '', { encoding: UTF8_ENCODING });
    } else if (fileInfo.isDirectory === true) {
      return null;
    }
    const nextInfo = await fs.getInfoAsync(targets.fileUri);
    return nextInfo.exists ? targets.fileUri : null;
  } catch (error) {
    logInternalFailure('legacy ensure log file', error);
    return null;
  }
}

export function isLoggingEnabled(): boolean {
  // settings can be briefly undefined (store still hydrating, partial test
  // stores); a log call must never throw over it.
  return useTaskStore.getState().settings?.diagnostics?.loggingEnabled === true;
}

function getFileSize(file: ExpoFile | null): number {
  if (!file) return 0;
  try {
    const info = file.info?.();
    if (typeof info?.size === 'number') return info.size;
  } catch {
  }
  return typeof file.size === 'number' ? file.size : 0;
}

async function rotateLogIfNeeded(force = false): Promise<void> {
  if (!LOG_FILE || !fileExists(LOG_FILE)) return;
  if (!force && logWriteCount > 0 && logWriteCount % LOG_ROTATION_CHECK_INTERVAL !== 0) return;
  if (getFileSize(LOG_FILE) <= MAX_LOG_FILE_BYTES) return;
  const current = await LOG_FILE.text().catch(() => '');
  const next = current.slice(-ROTATED_LOG_RETAIN_CHARS);
  LOG_FILE.write(next, { encoding: UTF8_ENCODING });
}

function appendWithFileHandle(line: string): boolean {
  if (!LOG_FILE || typeof LOG_FILE.open !== 'function') return false;
  let handle: ExpoFileHandle | null = null;
  try {
    handle = LOG_FILE.open();
    handle.offset = handle.size ?? 0;
    handle.writeBytes(new TextEncoder().encode(line));
    return true;
  } catch {
    return false;
  } finally {
    try {
      handle?.close();
    } catch {
    }
  }
}

async function appendLogLine(entry: LogEntry, options?: { force?: boolean }): Promise<string | null> {
  // Dev builds mirror every entry to the Metro console, gate or not: an Expo Go
  // tester has no way to hand over the log file, but can paste the terminal.
  logEntryToDevConsole(entry);
  if (!options?.force && !isLoggingEnabled()) return null;
  const backend = customLogBackend;
  const line = `${JSON.stringify(entry)}\n`;
  const pendingWrite = logWriteQueue.then(async () => {
    if (backend?.appendLogLine) {
      return backend.appendLogLine(entry, options);
    }
    try {
      await ensureLogDir();
      if (!await ensureLogFile()) throw new Error('primary log file unavailable');
      if (!LOG_FILE) return null;
      await rotateLogIfNeeded();
      if (appendWithFileHandle(line)) {
        logWriteCount += 1;
        await rotateLogIfNeeded(true);
        return LOG_FILE.uri;
      }
      const current = fileExists(LOG_FILE) ? await LOG_FILE.text().catch(() => '') : '';
      let next = current + line;
      if (next.length > MAX_LOG_FILE_BYTES) {
        next = next.slice(-ROTATED_LOG_RETAIN_CHARS);
      }
      LOG_FILE.write(next, { encoding: UTF8_ENCODING });
      logWriteCount += 1;
      return LOG_FILE.uri;
    } catch (error) {
      try {
        const fs = await getLegacyFileSystem();
        const path = await ensureLegacyLogFilePath();
        if (!fs || !path) return null;
        const info = await fs.getInfoAsync(path);
        const current = info.exists ? await fs.readAsStringAsync(path, { encoding: UTF8_ENCODING }).catch(() => '') : '';
        let next = current + line;
        if (next.length > MAX_LOG_FILE_BYTES) {
          next = next.slice(-ROTATED_LOG_RETAIN_CHARS);
        }
        await fs.writeAsStringAsync(path, next, { encoding: UTF8_ENCODING });
        logWriteCount += 1;
        return path;
      } catch {
        return null;
      }
    }
  });
  // Several notification-path callers intentionally do not await diagnostics.
  // Keep their file-handle offsets and read-modify-write fallbacks ordered so
  // adjacent receipt/outcome evidence cannot overwrite an earlier line (#1028).
  logWriteQueue = pendingWrite.then(() => undefined, () => undefined);
  return pendingWrite;
}

export async function getLogPath(): Promise<string | null> {
  if (customLogBackend?.getLogPath) {
    return customLogBackend.getLogPath();
  }
  await ensureLogTargets();
  if (LOG_FILE?.uri) return LOG_FILE.uri;
  const fs = await getLegacyFileSystem();
  return buildLegacyTargets(fs?.documentDirectory)?.fileUri ?? null;
}

export async function ensureLogFilePath(): Promise<string | null> {
  if (customLogBackend?.ensureLogFilePath) {
    return customLogBackend.ensureLogFilePath();
  }
  await ensureLogTargets();
  try {
    await ensureLogDir();
    if (!await ensureLogFile()) return await ensureLegacyLogFilePath();
    if (!LOG_FILE) return null;
    if (!fileExists(LOG_FILE)) return null;
    return LOG_FILE.uri;
  } catch (error) {
    logInternalFailure('ensure log file path', error);
    return await ensureLegacyLogFilePath();
  }
}

export async function clearLog(): Promise<void> {
  await logWriteQueue;
  if (customLogBackend?.clearLog) {
    await customLogBackend.clearLog();
    return;
  }
  await ensureLogTargets();
  try {
    if (LOG_FILE && fileExists(LOG_FILE)) {
      LOG_FILE.delete();
      logWriteCount = 0;
      return;
    }
    const fs = await getExpoFileSystem();
    if (LOG_FILE_URI && LOG_FILE_URI !== fs?.Paths?.document?.uri && fs) {
      const strayDir = new fs.Directory(LOG_FILE_URI);
      if (strayDir.exists) {
        strayDir.delete();
      }
    }
  } catch (error) {
    logInternalFailure('clear log', error);
  }
  try {
    const fs = await getLegacyFileSystem();
    const path = buildLegacyTargets(fs?.documentDirectory)?.fileUri;
    if (!fs || !path) return;
    await fs.deleteAsync(path, { idempotent: true });
    logWriteCount = 0;
  } catch (error) {
    logInternalFailure('legacy clear log', error);
  }
}

export async function readRecentLogText(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
  await logWriteQueue;
  await ensureLogTargets();
  try {
    if (!LOG_FILE || !fileExists(LOG_FILE)) throw new Error('primary log file unavailable');
    const raw = await LOG_FILE.text();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.slice(-Math.max(1, maxChars));
  } catch (error) {
    logInternalFailure('read recent log', error);
    try {
      const fs = await getLegacyFileSystem();
      const path = buildLegacyTargets(fs?.documentDirectory)?.fileUri;
      if (!fs || !path) return null;
      const info = await fs.getInfoAsync(path);
      if (!info.exists || info.isDirectory) return null;
      const raw = await fs.readAsStringAsync(path, { encoding: UTF8_ENCODING });
      const trimmed = raw.trim();
      if (!trimmed) return null;
      return trimmed.slice(-Math.max(1, maxChars));
    } catch (fallbackError) {
      logInternalFailure('legacy read recent log', fallbackError);
      return null;
    }
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
  context: { scope: string; url?: string; extra?: Record<string, unknown>; force?: boolean; message?: string }
): Promise<string | null> {
  const rawMessage = context.message ?? (error instanceof Error ? error.message : String(error));
  const rawStack = error instanceof Error ? error.stack : undefined;
  const message = sanitizeForLog(rawMessage);
  const stack = rawStack ? sanitizeForLog(rawStack) : undefined;
  const extra: Record<string, unknown> = {
    ...(context.extra ?? {}),
    ...(getBreadcrumbs().length > 0 ? { breadcrumbs: getBreadcrumbs().join(';') } : {}),
  };
  if (context.url) {
    const sanitizedUrl = sanitizeUrl(context.url);
    if (sanitizedUrl) {
      extra.url = sanitizedUrl;
    }
  }

  return appendLogLine({
    ts: new Date().toISOString(),
    level: 'error',
    scope: context.scope,
    message,
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
    url: context.url,
    extra: { backend: context.backend, step: context.step },
  });
}

let globalHandlersAttached = false;

export function setupGlobalErrorLogging(): void {
  if (globalHandlersAttached) return;
  globalHandlersAttached = true;

  const globalAny = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  };

  const defaultHandler = globalAny.ErrorUtils?.getGlobalHandler?.();
  globalAny.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    void logError(error, {
      scope: isFatal ? 'fatal' : 'error',
    });
    if (defaultHandler) {
      defaultHandler(error, isFatal);
    }
  });

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('unhandledrejection', (event: any) => {
      void logError(event?.reason, { scope: 'unhandledrejection' });
    });
  }
}
