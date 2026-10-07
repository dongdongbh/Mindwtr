import {
  buildDiagnosticsErrorEntry,
  buildDiagnosticsLogEntry,
  buildFeedbackDiagnostics,
  buildFeedbackDiagnosticsSnapshot,
  createDiagnosticsLog,
  createFeedbackDiagnosticsBuffer,
  FEEDBACK_DIAGNOSTICS_SOURCE_CHARS,
  getBreadcrumbs,
  isDiagnosticsLoggingEnabled,
  sanitizeForLog,
  useTaskStore,
  type DiagnosticsLog,
  type DiagnosticsLogEntry,
  type DiagnosticsLogFile,
} from '@mindwtr/core';
import * as ExpoLegacyFileSystem from 'expo-file-system/legacy';
import {
  createDefaultLocalFatalCrashCapture,
  type LocalFatalCrashCapture,
  type LocalFatalCrashMetadata,
  type RetainedFatalCrashSnapshot,
} from './mobile-crash-capture';

export const LOCAL_FATAL_CRASH_RELEASE_CHECK = 'v1.3.1/local-crash-capture';

const feedbackDiagnosticsBuffer = createFeedbackDiagnosticsBuffer();

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
  move?: (destination: ExpoFile) => void;
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
const RECENT_LOG_MAX_CHARS = 20_000;
const UTF8_ENCODING = 'utf8';

type LogEntry = DiagnosticsLogEntry;

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
let localFatalCrashCapture: LocalFatalCrashCapture | null | undefined;
let localFatalCrashRecovery: Promise<boolean> | null = null;

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
  return isDiagnosticsLoggingEnabled(useTaskStore.getState().settings);
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

/** Expo's file API: appends in place, trimmed by core's size cap. */
const primaryLogFile: DiagnosticsLogFile = {
  path: async () => {
    await ensureLogTargets();
    return LOG_FILE?.uri ?? null;
  },
  ensure: async () => {
    await ensureLogDir();
    if (!await ensureLogFile() || !LOG_FILE) return null;
    return LOG_FILE.uri;
  },
  exists: async () => {
    await ensureLogTargets();
    return fileExists(LOG_FILE);
  },
  read: async () => {
    if (!LOG_FILE) throw new Error('primary log file unavailable');
    return LOG_FILE.text();
  },
  write: async (text) => {
    if (!LOG_FILE) throw new Error('primary log file unavailable');
    LOG_FILE.write(text, { encoding: UTF8_ENCODING });
  },
  delete: async () => {
    await ensureLogTargets();
    if (LOG_FILE && fileExists(LOG_FILE)) {
      LOG_FILE.delete();
      return true;
    }
    const fs = await getExpoFileSystem();
    if (LOG_FILE_URI && LOG_FILE_URI !== fs?.Paths?.document?.uri && fs) {
      const strayDir = new fs.Directory(LOG_FILE_URI);
      if (strayDir.exists) {
        strayDir.delete();
      }
    }
    return false;
  },
  append: async (line) => appendWithFileHandle(line),
  size: async () => getFileSize(LOG_FILE),
  moveAside: async () => {
    const fs = await getExpoFileSystem();
    if (!fs || !LOG_FILE || !LOG_FILE_URI || typeof LOG_FILE.move !== 'function') throw new Error('primary log file unavailable');
    const aside = new fs.File(`${LOG_FILE_URI}.unreadable`);
    if (fileExists(aside)) aside.delete();
    LOG_FILE.move(aside);
    // Expo's move points the File at its new place: the next line starts a new file at the log's path.
    LOG_FILE = new fs.File(LOG_FILE_URI);
  },
};

const legacyLogPath = async (): Promise<{ fs: ExpoLegacyFileSystemModule; path: string } | null> => {
  const fs = await getLegacyFileSystem();
  const path = buildLegacyTargets(fs?.documentDirectory)?.fileUri;
  return fs && path ? { fs, path } : null;
};

/** Expo's legacy file API (Expo Go, older runtimes): every line rewrites the file. */
const legacyLogFile: DiagnosticsLogFile = {
  path: async () => (await legacyLogPath())?.path ?? null,
  ensure: ensureLegacyLogFilePath,
  exists: async () => {
    const target = await legacyLogPath();
    if (!target) return false;
    const info = await target.fs.getInfoAsync(target.path);
    return info.exists && !info.isDirectory;
  },
  read: async () => {
    const target = await legacyLogPath();
    if (!target) throw new Error('legacy log file unavailable');
    return target.fs.readAsStringAsync(target.path, { encoding: UTF8_ENCODING });
  },
  write: async (text) => {
    const target = await legacyLogPath();
    if (!target) throw new Error('legacy log file unavailable');
    await target.fs.writeAsStringAsync(target.path, text, { encoding: UTF8_ENCODING });
  },
  delete: async () => {
    const target = await legacyLogPath();
    if (!target) return false;
    await target.fs.deleteAsync(target.path, { idempotent: true });
    return true;
  },
};

// Core's file rules (diagnostics-log.ts): the gate, the line, the size cap, and one write at a time.
// Several notification-path callers intentionally do not await diagnostics; the log keeps their
// file-handle offsets and read-modify-write fallbacks ordered so adjacent receipt/outcome evidence
// cannot overwrite an earlier line (#1028). Made on first use: tests that replace @mindwtr/core as a
// whole still import this module.
let diagnosticsLogInstance: DiagnosticsLog | null = null;
const diagnosticsLog = (): DiagnosticsLog => {
  diagnosticsLogInstance ??= createDiagnosticsLog({ isEnabled: isLoggingEnabled, files: [primaryLogFile, legacyLogFile] });
  return diagnosticsLogInstance;
};

async function appendLogLine(entry: LogEntry, options?: { force?: boolean }): Promise<string | null> {
  feedbackDiagnosticsBuffer.record(entry);
  // Dev builds mirror every entry to the Metro console, gate or not: an Expo Go
  // tester has no way to hand over the log file, but can paste the terminal.
  logEntryToDevConsole(entry);
  const backend = customLogBackend;
  if (!backend?.appendLogLine) return diagnosticsLog().append(entry, options);
  if (!options?.force && !isLoggingEnabled()) return null;
  return diagnosticsLog().serialize(() => backend.appendLogLine!(entry, options));
}

const getLocalFatalCrashCapture = (
  metadata: LocalFatalCrashMetadata = {},
): LocalFatalCrashCapture | null => {
  if (localFatalCrashCapture === undefined) {
    localFatalCrashCapture = createDefaultLocalFatalCrashCapture(metadata);
  }
  return localFatalCrashCapture;
};

const readRetainedFatalCrashText = (): string | null => {
  try {
    return getLocalFatalCrashCapture()?.readText() ?? null;
  } catch {
    return null;
  }
};

const getRetainedFatalCrashPath = (): string | null => {
  try {
    return getLocalFatalCrashCapture()?.getPath() ?? null;
  } catch {
    return null;
  }
};

const runRetainedFatalCrashRecovery = async (): Promise<boolean> => {
  const capture = getLocalFatalCrashCapture();
  if (!capture) return false;
  let snapshot: RetainedFatalCrashSnapshot | null;
  try {
    snapshot = capture.readSnapshot();
  } catch {
    return false;
  }
  if (!snapshot) return false;
  try {
    const appendedPath = await appendLogLine(snapshot.entry, { force: true });
    if (!appendedPath) return false;
    const markerPath = await appendLogLine({
      ts: new Date().toISOString(),
      level: 'info',
      scope: 'diagnostics',
      message: 'Retained fatal JavaScript crash recovered',
      context: {
        releaseCheck: LOCAL_FATAL_CRASH_RELEASE_CHECK,
        count: '1',
      },
    }, { force: true });
    if (!markerPath) return false;
    capture.clearIfUnchanged(snapshot.identity);
    return true;
  } catch {
    return false;
  }
};

export function recoverRetainedFatalCrash(): Promise<boolean> {
  if (localFatalCrashRecovery) return localFatalCrashRecovery;
  const recovery = runRetainedFatalCrashRecovery();
  localFatalCrashRecovery = recovery;
  void recovery.finally(() => {
    if (localFatalCrashRecovery === recovery) localFatalCrashRecovery = null;
  });
  return recovery;
}

export async function getLogPath(): Promise<string | null> {
  if (customLogBackend?.getLogPath) {
    return customLogBackend.getLogPath();
  }
  return diagnosticsLog().path();
}

export async function ensureLogFilePath(): Promise<string | null> {
  await recoverRetainedFatalCrash();
  const retainedCrashPath = getRetainedFatalCrashPath();
  if (customLogBackend?.ensureLogFilePath) {
    const logPath = await customLogBackend.ensureLogFilePath();
    return retainedCrashPath ?? logPath;
  }
  const logPath = await diagnosticsLog().ensurePath();
  return retainedCrashPath ?? logPath;
}

export async function clearLog(): Promise<void> {
  if (localFatalCrashRecovery) {
    await localFatalCrashRecovery.catch(() => false);
  }
  feedbackDiagnosticsBuffer.clear();
  try {
    const backend = customLogBackend;
    if (backend?.clearLog) {
      await diagnosticsLog().serialize(() => backend.clearLog!());
      return;
    }
    await diagnosticsLog().clear();
  } finally {
    try {
      getLocalFatalCrashCapture()?.clear();
    } catch {
    }
  }
}

const withRetainedFatalCrash = (
  logText: string | null,
  retainedCrashText: string | null,
  maxChars: number,
): string | null => {
  const combined = [logText?.trim(), retainedCrashText?.trim()].filter(Boolean).join('\n');
  return combined ? combined.slice(-Math.max(1, maxChars)) : null;
};

export async function readRecentLogText(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
  await recoverRetainedFatalCrash();
  const retainedCrashText = readRetainedFatalCrashText();
  return withRetainedFatalCrash(await diagnosticsLog().read(), retainedCrashText, maxChars);
}

export async function collectFeedbackDiagnostics(maxChars = RECENT_LOG_MAX_CHARS): Promise<string | null> {
  const breadcrumbs = getBreadcrumbs();
  // Feedback attachment is an explicit, one-time opt-in. Build the snapshot in
  // memory so checking the box does not persist a log when detailed logging is
  // disabled, while still explaining the recent app flow.
  const snapshot = buildFeedbackDiagnosticsSnapshot({ debugLoggingEnabled: isLoggingEnabled(), breadcrumbs });
  const recentLogs = await readRecentLogText(FEEDBACK_DIAGNOSTICS_SOURCE_CHARS);
  return buildFeedbackDiagnostics(
    [recentLogs, feedbackDiagnosticsBuffer.read(), readRetainedFatalCrashText()],
    snapshot,
    maxChars,
  );
}

export async function logError(
  error: unknown,
  context: { scope: string; url?: string; extra?: Record<string, unknown>; force?: boolean; message?: string }
): Promise<string | null> {
  return appendLogLine(buildDiagnosticsErrorEntry(error, context), { force: context.force });
}

export async function logInfo(
  message: string,
  context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }
): Promise<string | null> {
  return appendLogLine(buildDiagnosticsLogEntry('info', message, context), { force: context?.force });
}

export async function logWarn(
  message: string,
  context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }
): Promise<string | null> {
  return appendLogLine(buildDiagnosticsLogEntry('warn', message, context), { force: context?.force });
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

export type GlobalErrorLoggingOptions = {
  crashCapture?: LocalFatalCrashCapture | null;
  crashMetadata?: LocalFatalCrashMetadata;
};

export function setupGlobalErrorLogging(options: GlobalErrorLoggingOptions = {}): void {
  if (globalHandlersAttached) return;
  globalHandlersAttached = true;

  localFatalCrashCapture = Object.prototype.hasOwnProperty.call(options, 'crashCapture')
    ? options.crashCapture ?? null
    : createDefaultLocalFatalCrashCapture(options.crashMetadata);

  const globalAny = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  };

  const defaultHandler = globalAny.ErrorUtils?.getGlobalHandler?.();
  globalAny.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    try {
      if (isFatal) {
        try {
          localFatalCrashCapture?.capture(error);
        } catch {
          // Fatal delegation must never depend on the best-effort local slot.
        }
      }
      void logError(error, {
        scope: isFatal ? 'fatal' : 'error',
      }).catch(() => undefined);
    } finally {
      if (defaultHandler) {
        defaultHandler(error, isFatal);
      }
    }
  });

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('unhandledrejection', (event: any) => {
      void logError(event?.reason, { scope: 'unhandledrejection' }).catch(() => undefined);
    });
  }
}

export const __appLogTestUtils = {
  resetGlobalErrorLogging(): void {
    globalHandlersAttached = false;
    localFatalCrashCapture = undefined;
    localFatalCrashRecovery = null;
  },
  setLocalFatalCrashCapture(capture: LocalFatalCrashCapture | null): void {
    localFatalCrashCapture = capture;
    localFatalCrashRecovery = null;
  },
};
