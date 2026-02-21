import { Platform } from 'react-native';

const STARTUP_TAG = 'MindwtrStartup';
const moduleLoadedAtMs = Date.now();
const profilingEnv = String(process.env.EXPO_PUBLIC_STARTUP_PROFILING || '').trim().toLowerCase();
const startupProfilingEnabled = Platform.OS === 'android' && (profilingEnv === '1' || profilingEnv === 'true');
if (startupProfilingEnabled) {
  (globalThis as Record<string, unknown>).__MINDWTR_STARTUP_PROFILING__ = true;
}

const serializeExtra = (extra?: Record<string, unknown>): string => {
  if (!extra) return '';
  const parts = Object.entries(extra)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

const logStartupLine = (line: string): void => {
  const maybeHook = (globalThis as { nativeLoggingHook?: unknown }).nativeLoggingHook;
  if (typeof maybeHook === 'function') {
    try {
      (maybeHook as (message: string, level: number) => void)(line, 1);
      return;
    } catch {
      // Fall back to console logging.
    }
  }
  console.info(line);
};

export const isStartupProfilingEnabled = (): boolean => startupProfilingEnabled;

export const markStartupPhase = (phase: string, extra?: Record<string, unknown>): void => {
  if (!startupProfilingEnabled) return;
  const nowMs = Date.now();
  const sinceJsStartMs = nowMs - moduleLoadedAtMs;
  const extraPayload = serializeExtra(extra);
  logStartupLine(`[${STARTUP_TAG}] phase=${phase} wallMs=${nowMs} sinceJsStartMs=${sinceJsStartMs}${extraPayload}`);
};

export const measureStartupPhase = async <T>(
  phase: string,
  work: () => Promise<T> | T
): Promise<T> => {
  if (!startupProfilingEnabled) {
    return await work();
  }
  const startMs = Date.now();
  markStartupPhase(`${phase}:start`);
  try {
    return await work();
  } finally {
    markStartupPhase(`${phase}:end`, { durationMs: Date.now() - startMs });
  }
};

markStartupPhase('js.startup_profiler.module_loaded');
