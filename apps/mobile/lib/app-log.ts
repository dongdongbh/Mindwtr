import * as FileSystem from 'expo-file-system';
import { useTaskStore } from '@mindwtr/core';

const LOG_DIR = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}logs` : null;
const LOG_FILE = LOG_DIR ? `${LOG_DIR}/mindwtr.log` : null;
const MAX_LOG_CHARS = 200_000;
const SENSITIVE_KEYS = ['token', 'access_token', 'password', 'pass', 'apikey', 'api_key', 'key', 'auth', 'authorization', 'username', 'user'];

type LogEntry = {
  ts: string;
  level: 'info' | 'error';
  scope: string;
  message: string;
  stack?: string;
  context?: Record<string, string>;
};

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
  if (!LOG_DIR) return;
  await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
}

function isLoggingEnabled(): boolean {
  return useTaskStore.getState().settings.diagnostics?.loggingEnabled === true;
}

async function appendLogLine(entry: LogEntry): Promise<string | null> {
  if (!isLoggingEnabled()) return null;
  if (!LOG_FILE) return null;
  try {
    await ensureLogDir();
    const line = `${JSON.stringify(entry)}\n`;
    const current = await FileSystem.readAsStringAsync(LOG_FILE, { encoding: FileSystem.EncodingType.UTF8 }).catch(() => '');
    let next = current + line;
    if (next.length > MAX_LOG_CHARS) {
      next = next.slice(-MAX_LOG_CHARS);
    }
    await FileSystem.writeAsStringAsync(LOG_FILE, next, { encoding: FileSystem.EncodingType.UTF8 });
    return LOG_FILE;
  } catch (error) {
    console.warn('[Mobile] Failed to write log', error);
    return null;
  }
}

export async function getLogPath(): Promise<string | null> {
  return LOG_FILE;
}

export async function clearLog(): Promise<void> {
  if (!LOG_FILE) return;
  try {
    await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
  } catch (error) {
    console.warn('[Mobile] Failed to clear log', error);
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
    extra.url = sanitizeUrl(context.url);
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
