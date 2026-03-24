import { useTaskStore } from '@mindwtr/core';

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
  write: (content: string, options?: { encoding?: string }) => void;
  text: () => Promise<string>;
  uri: string;
};

type ExpoFileSystemModule = {
  Directory: new (uri: string) => ExpoDirectory;
  File: new (uri: string) => ExpoFile;
  Paths: { document?: { uri: string } };
};

let expoFileSystemModule: ExpoFileSystemModule | null | undefined;
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
const MAX_LOG_CHARS = 200_000;
const SENSITIVE_KEYS = [
  'token',
  'access_token',
  'password',
  'pass',
  'apikey',
  'api_key',
  'key',
  'secret',
  'auth',
  'authorization',
  'username',
  'user',
  'session',
  'cookie',
];

const AI_KEY_PATTERNS = [
  /sk-[A-Za-z0-9]{10,}/g,
  /sk-ant-[A-Za-z0-9]{10,}/g,
  /rk-[A-Za-z0-9]{10,}/g,
  /AIza[0-9A-Za-z\-_]{10,}/g,
];

const ICS_URL_PATTERN = /\b(?:https?|webcal|webcals):\/\/[^\s'")]+/gi;

type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  stack?: string;
  context?: Record<string, string>;
};

function redactSensitiveText(value: string): string {
  let result = value;
  result = result.replace(/(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+\/=._-]+/gi, '$1$2 [redacted]');
  result = result.replace(
    /(password|pass|token|access_token|api_key|apikey|authorization|username|user|secret|session|cookie)=([^\s&]+)/gi,
    '$1=[redacted]'
  );
  for (const pattern of AI_KEY_PATTERNS) {
    result = result.replace(pattern, '[redacted]');
  }
  result = result.replace(ICS_URL_PATTERN, (match) => sanitizeUrl(match) ?? match);
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
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (scheme === 'webcal' || scheme === 'webcals' || parsed.pathname.toLowerCase().includes('.ics')) {
      return '[redacted-ics-url]';
    }
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
        return false;
      }
    }
  }
  return fileExists(LOG_FILE);
}

function isLoggingEnabled(): boolean {
  return useTaskStore.getState().settings.diagnostics?.loggingEnabled === true;
}

async function appendLogLine(entry: LogEntry, options?: { force?: boolean }): Promise<string | null> {
  if (!options?.force && !isLoggingEnabled()) return null;
  try {
    await ensureLogDir();
    if (!await ensureLogFile()) return null;
    if (!LOG_FILE) return null;
    const line = `${JSON.stringify(entry)}\n`;
    const current = fileExists(LOG_FILE) ? await LOG_FILE.text().catch(() => '') : '';
    let next = current + line;
    if (next.length > MAX_LOG_CHARS) {
      next = next.slice(-MAX_LOG_CHARS);
    }
    LOG_FILE.write(next, { encoding: 'utf8' });
    return LOG_FILE.uri;
  } catch (error) {
    return null;
  }
}

export async function getLogPath(): Promise<string | null> {
  await ensureLogTargets();
  return LOG_FILE?.uri ?? null;
}

export async function ensureLogFilePath(): Promise<string | null> {
  await ensureLogTargets();
  try {
    await ensureLogDir();
    if (!await ensureLogFile()) return null;
    if (!LOG_FILE) return null;
    if (!fileExists(LOG_FILE)) return null;
    return LOG_FILE.uri;
  } catch {
    return null;
  }
}

export async function clearLog(): Promise<void> {
  await ensureLogTargets();
  if (!LOG_FILE) return;
  try {
    if (fileExists(LOG_FILE)) {
      LOG_FILE.delete();
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
  }
}

export async function logError(
  error: unknown,
  context: { scope: string; url?: string; extra?: Record<string, string> }
): Promise<string | null> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack : undefined;
  const message = redactSensitiveText(rawMessage);
  const stack = rawStack ? redactSensitiveText(rawStack) : undefined;
  const extra = { ...(context.extra ?? {}) };
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
    context: Object.keys(extra).length ? sanitizeContext(extra) : undefined,
  });
}

export async function logInfo(
  message: string,
  context?: { scope?: string; extra?: Record<string, string>; force?: boolean }
): Promise<string | null> {
  const safeMessage = redactSensitiveText(message);
  return appendLogLine({
    ts: new Date().toISOString(),
    level: 'info',
    scope: context?.scope ?? 'info',
    message: safeMessage,
    context: sanitizeContext(context?.extra),
  }, { force: context?.force });
}

export async function logWarn(
  message: string,
  context?: { scope?: string; extra?: Record<string, string> }
): Promise<string | null> {
  const safeMessage = redactSensitiveText(message);
  return appendLogLine({
    ts: new Date().toISOString(),
    level: 'warn',
    scope: context?.scope ?? 'warn',
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
